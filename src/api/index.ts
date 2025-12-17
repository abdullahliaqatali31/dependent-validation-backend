import express from 'express';
import cors from 'cors';
import { config } from '../config';
import { query } from '../db';
import { dedupeQueue, filterQueue } from '../queues';
import { personalQueue, validationQueue, validationQueues, QUEUE_NAMES } from '../queues';
import { publish, CHANNELS, redis } from '../redis';
import { ensureBatchActivated, assignWorkerRoundRobin, releaseBatchAssignment } from '../utils/validationAssignment';
import { createClient } from '@supabase/supabase-js';

const app = express();
// CORS: allow frontend dev origins and necessary headers/methods
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
// Handle preflight quickly
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// Supabase Admin client for server-side user management
const supabaseAdmin = (config.supabaseUrl && config.supabaseServiceRoleKey)
  ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
  : null;

function getSupabaseUser(req: express.Request): { id?: string; role?: string } {
  const auth = req.header('authorization') || '';
  const qToken = (req.query?.token as string) || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : (qToken || null);
  if (!token) return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) || {};
    const id = payload.sub || (payload.user && payload.user.id) || undefined;
    const am = (payload.app_metadata as any) || {};
    const um = (payload.user_metadata as any) || {};
    let role: string | undefined = undefined;
    if (typeof am.role === 'string') role = am.role;
    else if (typeof um.role === 'string') role = um.role;
    else if (Array.isArray(am.roles) && am.roles.some((r: any) => String(r || '').toLowerCase() === 'admin')) role = 'admin';
    else if (Array.isArray(um.roles) && um.roles.some((r: any) => String(r || '').toLowerCase() === 'admin')) role = 'admin';
    else if (am.is_admin === true || um.is_admin === true || am.isAdmin === true || um.isAdmin === true || am.admin === true || um.admin === true) role = 'admin';
    return { id, role };
  } catch {
    return {};
  }
}

function requireAdmin(req: express.Request, res: express.Response): boolean {
  const { role } = getSupabaseUser(req);
  if (String(role || '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

app.post('/upload', async (req, res) => {
  try {
    const { emails, submitter_id, submitter_team_id, submitter_uuid: submitter_uuid_body } = req.body || {};
    const { id: submitter_uuid_token } = getSupabaseUser(req);
    const submitter_uuid = submitter_uuid_body || submitter_uuid_token || null;
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'Provide emails: string[]' });
    }

    const batch = await query<{ batch_id: number }>(
      'INSERT INTO batches(submitter_id, submitter_uuid, submitter_team_id, total_count, status) VALUES ($1, $2, $3, $4, $5) RETURNING batch_id',
      [submitter_id || 0, submitter_uuid, submitter_team_id || null, emails.length, 'uploaded']
    );
    const batchId = batch.rows[0].batch_id;

    // Bulk insert into staging
    const values = emails.map((e, i) => `(${batchId}, ${'$' + (i + 1)})`).join(',');
    await query(
      `INSERT INTO master_emails_temp(batch_id, email_raw) VALUES ${values}`,
      emails
    );

    await dedupeQueue.add('dedupeBatch', { batchId }, { removeOnComplete: true, removeOnFail: true });
    await publish(CHANNELS.batchProgress, { batchId, stage: 'uploaded', count: emails.length });

    res.json({ batchId, queued: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'upload_failed', details: err.message });
  }
});

app.get('/batches/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const b = await query('SELECT * FROM batches WHERE batch_id=$1', [id]);
    const staged = await query('SELECT COUNT(*) FROM master_emails_temp WHERE batch_id=$1', [id]);
    const master = await query('SELECT COUNT(*) FROM master_emails WHERE batch_id=$1', [id]);
    const filtered = await query('SELECT COUNT(*) FROM filtered_emails WHERE batch_id=$1', [id]);
    const filtered_rules = await query(
      `SELECT COUNT(*) FROM filtered_emails WHERE batch_id=$1 AND status LIKE 'removed:%'`,
      [id]
    );
    const filtered_unsub = await query(
      `SELECT COUNT(*) FROM filtered_emails WHERE batch_id=$1 AND reason='unsubscribed'`,
      [id]
    );
    const personal = await query('SELECT COUNT(*) FROM personal_emails pe JOIN master_emails me ON pe.master_id=me.id WHERE me.batch_id=$1', [id]);
    const validated = await query('SELECT COUNT(*) FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1', [id]);
    const total = Number((b.rows[0]?.total_count ?? 0) as number);
    const stagedCount = Number(staged.rows[0].count || 0);
    const masterCount = Number(master.rows[0].count || 0);
    // Duplicates are emails that have been processed from staging but not inserted into master
    // This formula remains 0 before dedupe runs (staged === total), and equals (total - master) once dedupe completes.
    const duplicates = Math.max(0, total - stagedCount - masterCount);
    res.json({
      batch: b.rows[0] || null,
      counts: {
        staged: stagedCount,
        master: masterCount,
        filtered: Number(filtered.rows[0].count || 0),
        filtered_rules: Number(filtered_rules.rows[0].count || 0),
        filtered_unsub: Number(filtered_unsub.rows[0].count || 0),
        personal: Number(personal.rows[0].count || 0),
        validated: Number(validated.rows[0].count || 0),
        duplicates
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'status_failed', details: err.message });
  }
});

app.get('/batches/:id/steps', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const totalUploadedQ = await query<{ c: string }>('SELECT total_count AS c FROM batches WHERE batch_id=$1', [id]);
    const stagedQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM master_emails_temp WHERE batch_id=$1', [id]);
    const masterQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM master_emails WHERE batch_id=$1', [id]);
    const filteredQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1', [id]);
    const cleanQ = await query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1 AND (status='clean' OR status LIKE 'repaired:%')`,
      [id]
    );
    const passedFilterQ = await query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1 AND status NOT LIKE 'removed:%'`,
      [id]
    );
    const validatedQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1', [id]);
    const personalQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM personal_emails pe JOIN master_emails me ON pe.master_id=me.id WHERE me.batch_id=$1', [id]);

    const totalUploaded = Number(totalUploadedQ.rows[0]?.c || 0);
    const staged = Number(stagedQ.rows[0]?.c || 0);
    const master = Number(masterQ.rows[0]?.c || 0);
    const filtered = Number(filteredQ.rows[0]?.c || 0);
    const cleaned = Number(cleanQ.rows[0]?.c || 0);
    const passedFilter = Number(passedFilterQ.rows[0]?.c || 0);
    const validated = Number(validatedQ.rows[0]?.c || 0);
    const personal = Number(personalQ.rows[0]?.c || 0);

    res.json({
      upload: { processed: totalUploaded, total: totalUploaded },
      dedupe: { processed: master, total: staged + master },
      filter: { processed: filtered, total: master },
      clean: { processed: cleaned, total: master },
      validation: { processed: validated, total: passedFilter },
      split: { processed: personal, total: validated },
      done: { processed: validated, total: passedFilter }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'steps_failed', details: err.message });
  }
});

app.get('/batches/:id/filter-stats', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const removedContains = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1 AND status='removed:contains_keyword'`, [id]);
    const removedEndswith = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1 AND status='removed:endswith_rule'`, [id]);
    const removedInvalid = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1 AND status='removed:invalid_format'`, [id]);
    const repaired = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1 AND status LIKE 'repaired:%'`, [id]);
    const clean = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1 AND status='clean'`, [id]);
    res.json({
      removed_contains: Number(removedContains.rows[0]?.c || 0),
      removed_endswith: Number(removedEndswith.rows[0]?.c || 0),
      removed_invalid: Number(removedInvalid.rows[0]?.c || 0),
      repaired: Number(repaired.rows[0]?.c || 0),
      clean: Number(clean.rows[0]?.c || 0)
    });
  } catch (err: any) {
    res.status(500).json({ error: 'filter_stats_failed', details: err.message });
  }
});

app.get('/batches/:id/validation-stats', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const bizAccepted = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1 AND category='business' AND outcome='accepted'`, [id]);
    const bizCatch = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1 AND category='business' AND outcome='catch_all'`, [id]);
    const bizRejected = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1 AND category='business' AND outcome='rejected'`, [id]);
    const bizTimeout = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1 AND category='business' AND outcome='timeout'`, [id]);
    const perAccepted = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1 AND category='personal' AND outcome='accepted'`, [id]);
    const perCatch = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1 AND category='personal' AND outcome='catch_all'`, [id]);
    const perRejected = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1 AND category='personal' AND outcome='rejected'`, [id]);
    const perTimeout = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1 AND category='personal' AND outcome='timeout'`, [id]);
    res.json({
      business: { accepted: Number(bizAccepted.rows[0]?.c || 0), catch_all: Number(bizCatch.rows[0]?.c || 0), rejected: Number(bizRejected.rows[0]?.c || 0), timeout: Number(bizTimeout.rows[0]?.c || 0) },
      personal: { accepted: Number(perAccepted.rows[0]?.c || 0), catch_all: Number(perCatch.rows[0]?.c || 0), rejected: Number(perRejected.rows[0]?.c || 0), timeout: Number(perTimeout.rows[0]?.c || 0) }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'validation_stats_failed', details: err.message });
  }
});

app.get('/batches/:id/split-stats', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const business = await query<{ c: string }>('SELECT COUNT(*) AS c FROM final_business_emails WHERE batch_id=$1', [id]);
    const personal = await query<{ c: string }>('SELECT COUNT(*) AS c FROM final_personal_emails WHERE batch_id=$1', [id]);
    res.json({ business: Number(business.rows[0]?.c || 0), personal: Number(personal.rows[0]?.c || 0) });
  } catch (err: any) {
    res.status(500).json({ error: 'split_stats_failed', details: err.message });
  }
});

app.get('/batches/:id/validation-summary', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const rows = await query(
      `SELECT category, outcome, COUNT(*) AS c
       FROM validation_results vr
       JOIN master_emails me ON vr.master_id=me.id
       WHERE me.batch_id=$1 AND COALESCE(vr.is_downloaded,false)=false
       GROUP BY category, outcome`,
      [id]
    );
    const result: any = { business: { accepted: 0, catch_all: 0, rejected: 0, timeout: 0 }, personal: { accepted: 0, catch_all: 0, rejected: 0, timeout: 0 } };
    for (const r of rows.rows as any[]) {
      const cat = String(r.category || '').toLowerCase();
      const out = String(r.outcome || '').toLowerCase();
      const count = Number(r.c || 0);
      if (cat === 'business' && result.business[out] !== undefined) result.business[out] = count;
      if (cat === 'personal' && result.personal[out] !== undefined) result.personal[out] = count;
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'validation_summary_failed', details: err.message });
  }
});

app.get('/batches/:id/split-summary', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const biz = await query('SELECT outcome, COUNT(*) AS c FROM final_business_emails WHERE batch_id=$1 GROUP BY outcome', [id]);
    const per = await query('SELECT outcome, COUNT(*) AS c FROM final_personal_emails WHERE batch_id=$1 GROUP BY outcome', [id]);
    const result: any = { business: { accepted: 0, catch_all: 0, rejected: 0, timeout: 0 }, personal: { accepted: 0, catch_all: 0, rejected: 0, timeout: 0 } };
    for (const r of biz.rows as any[]) result.business[String(r.outcome || '')] = Number(r.c || 0);
    for (const r of per.rows as any[]) result.personal[String(r.outcome || '')] = Number(r.c || 0);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'split_summary_failed', details: err.message });
  }
});

app.get('/employee/results/by-category', async (req, res) => {
  try {
    const category = String((req.query.category || '').toString()).toLowerCase();
    const outcome = String((req.query.outcome || '').toString()).toLowerCase();
    const batchId = (req.query.batch_id || '').toString();
    const employeeId = (req.query.employee_id || '').toString();
    if (!['business','personal'].includes(category) || !['accepted','catch_all','rejected','timeout'].includes(outcome)) return res.status(400).json({ error: 'invalid_params' });
    if (!batchId && !employeeId) return res.status(400).json({ error: 'missing_scope' });
    let sql =
      `SELECT me.email_normalized AS email,
              COALESCE(vr.details->>'reason', vr.details->>'error', vr.message) AS reason
       FROM validation_results vr
       JOIN master_emails me ON vr.master_id=me.id
       WHERE vr.category=$1 AND vr.outcome=$2 AND COALESCE(vr.is_downloaded,false)=false`;
    const params: any[] = [category, outcome];
    if (batchId) { sql += ` AND me.batch_id=$3`; params.push(Number(batchId)); }
    else { sql += ` AND me.submitter_uuid=$3`; params.push(employeeId); }
    sql += ` ORDER BY vr.validated_at DESC LIMIT 2000`;
    const rows = await query<{ email: string; reason: string | null }>(sql, params);
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'employee_results_by_category_failed', details: err.message });
  }
});

app.get('/batches/:id/filtration', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const byStatus = await query<{ status: string; c: string }>(
      `SELECT status, COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1 GROUP BY status ORDER BY status`,
      [id]
    );
    const byReason = await query<{ reason: string; c: string }>(
      `SELECT reason, COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1 GROUP BY reason ORDER BY COUNT(*) DESC`,
      [id]
    );
    const topContains = await query<{ kw: string | null; c: string }>(
      `SELECT COALESCE(metadata->>'matched_keyword','') AS kw, COUNT(*) AS c
       FROM filtered_emails
       WHERE batch_id=$1 AND status='removed:contains_keyword'
       GROUP BY kw
       ORDER BY COUNT(*) DESC
       LIMIT 20`,
      [id]
    );
    const topEndswith = await query<{ kw: string | null; c: string }>(
      `SELECT COALESCE(metadata->>'matched_keyword','') AS kw, COUNT(*) AS c
       FROM filtered_emails
       WHERE batch_id=$1 AND status='removed:endswith_rule'
       GROUP BY kw
       ORDER BY COUNT(*) DESC
       LIMIT 20`,
      [id]
    );
    const repairs = await query<{ repair: string | null; c: string }>(
      `SELECT r.repair, COUNT(*) AS c
       FROM (
         SELECT unnest(string_to_array(reason, ',')) AS repair
         FROM filtered_emails
         WHERE batch_id=$1 AND status LIKE 'repaired:%'
       ) r
       GROUP BY r.repair
       ORDER BY COUNT(*) DESC
       LIMIT 20`,
      [id]
    );
    res.json({
      by_status: byStatus.rows.map(r => ({ status: r.status, count: Number(r.c || 0) })),
      by_reason: byReason.rows.map(r => ({ reason: r.reason, count: Number(r.c || 0) })),
      top_contains: topContains.rows.map(r => ({ keyword: r.kw || '', count: Number(r.c || 0) })),
      top_endswith: topEndswith.rows.map(r => ({ suffix: r.kw || '', count: Number(r.c || 0) })),
      repairs: repairs.rows.map(r => ({ rule: r.repair || '', count: Number(r.c || 0) }))
    });
  } catch (err: any) {
    res.status(500).json({ error: 'filtration_breakdown_failed', details: err.message });
  }
});

// Re-run pipeline for an existing batch: clears downstream tables and re-enqueues filter jobs
app.post('/batches/:id/rerun', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const exists = await query('SELECT 1 FROM batches WHERE batch_id=$1', [id]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'batch_not_found' });

    // Collect master email IDs for this batch
    const masters = await query<{ id: number }>('SELECT id FROM master_emails WHERE batch_id=$1', [id]);
    const masterIds = masters.rows.map(r => r.id);

    if (masterIds.length === 0) {
      return res.json({ batchId: id, queued: false, message: 'no_master_emails' });
    }

    await query('DELETE FROM filtered_emails WHERE master_id = ANY($1::bigint[])', [masterIds]);
    await query('DELETE FROM personal_emails WHERE master_id = ANY($1::bigint[])', [masterIds]);
    await query('DELETE FROM validation_results WHERE master_id = ANY($1::bigint[])', [masterIds]);
    await query('DELETE FROM final_business_emails WHERE batch_id=$1', [id]);
    await query('DELETE FROM final_personal_emails WHERE batch_id=$1', [id]);

    // Re-enqueue filter jobs which drive downstream stages
    for (const mid of masterIds) {
      await filterQueue.add('filterEmail', { masterId: mid }, { removeOnComplete: true, removeOnFail: true });
    }

    // Mark batch status as requeued (optional status tracking)
    await query('UPDATE batches SET status=$2 WHERE batch_id=$1', [id, 'requeued']);

    await publish(CHANNELS.batchProgress, { batchId: id, stage: 'rerun_started', count: masterIds.length });
    res.json({ batchId: id, queued: true, count: masterIds.length });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'rerun_failed', details: err.message });
  }
});

app.post('/batches/:id/pause', async (req, res) => {
  const id = Number(req.params.id);
  const stage = String((req.body?.stage || '').toString().toLowerCase());
  if (!id || !['dedupe','filter','validation','personal'].includes(stage)) {
    return res.status(400).json({ error: 'invalid_id_or_stage' });
  }
  try {
    await query('UPDATE batches SET status=$2, paused_stage=$3, paused_at=now() WHERE batch_id=$1', [id, 'paused', stage]);
    await publish(CHANNELS.batchProgress, { batchId: id, stage: 'paused', paused_stage: stage });
    res.json({ ok: true, batchId: id, stage });
  } catch (err: any) {
    res.status(500).json({ error: 'pause_failed', details: err.message });
  }
});

app.post('/batches/:id/resume', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const b = await query<{ paused_stage: string | null }>('SELECT paused_stage FROM batches WHERE batch_id=$1', [id]);
    const stage = String(b.rows[0]?.paused_stage || '').toLowerCase();
    if (!['dedupe','filter','validation','personal'].includes(stage)) {
      return res.status(400).json({ error: 'not_paused_or_unknown_stage' });
    }
    await query('UPDATE batches SET status=$2, paused_stage=NULL, paused_at=NULL WHERE batch_id=$1', [id, 'resumed']);

    if (stage === 'dedupe') {
      await dedupeQueue.add('dedupeBatch', { batchId: id }, { removeOnComplete: true, removeOnFail: true });
    } else if (stage === 'filter') {
      const masters = await query<{ id: number }>(
        `SELECT me.id
         FROM master_emails me
         WHERE me.batch_id=$1
           AND NOT EXISTS (SELECT 1 FROM filtered_emails fe WHERE fe.master_id=me.id)`,
        [id]
      );
      for (const r of masters.rows) {
        await filterQueue.add('filterEmail', { masterId: r.id }, { removeOnComplete: true, removeOnFail: true });
      }
    } else if (stage === 'validation') {
      const masters = await query<{ id: number }>(
        `SELECT me.id
         FROM master_emails me
         WHERE me.batch_id=$1
           AND EXISTS (
             SELECT 1 FROM filtered_emails fe
             WHERE fe.master_id=me.id AND fe.status NOT LIKE 'removed:%'
           )
           AND NOT EXISTS (SELECT 1 FROM validation_results vr WHERE vr.master_id=me.id)`,
        [id]
      );
      for (const r of masters.rows) {
        await validationQueue.add('validateEmail', { masterId: r.id }, { removeOnComplete: true, removeOnFail: true });
      }
    } else if (stage === 'personal') {
      const masters = await query<{ id: number }>(
        `SELECT me.id
         FROM master_emails me
         WHERE me.batch_id=$1
           AND EXISTS (SELECT 1 FROM validation_results vr WHERE vr.master_id=me.id)
           AND NOT EXISTS (SELECT 1 FROM personal_emails pe WHERE pe.master_id=me.id)`,
        [id]
      );
      for (const r of masters.rows) {
        await publish(CHANNELS.batchProgress, { batchId: id, stage: 'resume_enqueue', master_id: r.id });
      }
    }

    await publish(CHANNELS.batchProgress, { batchId: id, stage: 'resume_started', resume_stage: stage });
    res.json({ ok: true, batchId: id, resume_stage: stage });
  } catch (err: any) {
    res.status(500).json({ error: 'resume_failed', details: err.message });
  }
});

app.post('/batches/:id/unstick', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const b = await query<{ status: string }>('SELECT status FROM batches WHERE batch_id=$1', [id]);
    if (b.rows.length === 0) return res.status(404).json({ error: 'batch_not_found' });

    console.log(`Unsticking batch ${id}...`);

    // 1. Clear locks
    try {
      await releaseBatchAssignment(id);
    } catch (e) {
      console.error('Release assignment failed:', e);
    }

    // 2. Re-enqueue filter jobs (limit to 10k to be safe)
    const filterPending = await query<{ id: number }>(
      `SELECT me.id
       FROM master_emails me
       WHERE me.batch_id=$1
         AND NOT EXISTS (SELECT 1 FROM filtered_emails fe WHERE fe.master_id=me.id)
       ORDER BY me.id
       LIMIT 10000`,
      [id]
    );
    let filterEnq = 0;
    for (const r of filterPending.rows) {
      await filterQueue.add('filterEmail', { masterId: r.id }, { removeOnComplete: true, removeOnFail: true });
      filterEnq++;
    }

    // 3. Re-enqueue validation jobs
    const valPending = await query<{ id: number }>(
      `SELECT me.id
       FROM master_emails me
       JOIN filtered_emails fe ON fe.master_id=me.id
       WHERE me.batch_id=$1
         AND fe.status NOT LIKE 'removed:%'
         AND NOT EXISTS (SELECT 1 FROM validation_results vr WHERE vr.master_id=me.id)
       ORDER BY me.id
       LIMIT 10000`,
      [id]
    );
    let valEnq = 0;
    if (valPending.rows.length > 0) {
      await ensureBatchActivated(id);
      for (const r of valPending.rows) {
        const idx = await assignWorkerRoundRobin(id);
        const q = validationQueues[idx] || validationQueues[0];
        await q.add('validateEmail', { masterId: r.id }, { removeOnComplete: false, removeOnFail: false });
        valEnq++;
      }
    }

    await publish(CHANNELS.batchProgress, { batchId: id, stage: 'unstick', filter_requeued: filterEnq, validation_requeued: valEnq });
    res.json({ ok: true, batchId: id, filter_requeued: filterEnq, validation_requeued: valEnq });
  } catch (err: any) {
    res.status(500).json({ error: 'unstick_failed', details: err.message });
  }
});

// Employee: validation results list
app.get('/employee/results', async (req, res) => {
  try {
    const employeeId = String((req.query.employee_id || '').toString());
    const type = String((req.query.type || 'valid').toString()).toLowerCase();
    const q = String((req.query.q || '').toString());
    if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });

    const like = q ? `%${q}%` : '';

    if (type === 'valid') {
      const rows = await query<{ email: string }>(
        `SELECT me.email_normalized AS email
         FROM validation_results vr
         JOIN master_emails me ON vr.master_id = me.id
         WHERE me.submitter_uuid = $1
           AND vr.status_enum IN ('valid','catch_all')
           AND ($2::text = '' OR me.email_normalized ILIKE $2)
         ORDER BY vr.validated_at DESC
         LIMIT 500`,
        [employeeId, like]
      );
      return res.json(rows.rows);
    }

    if (type === 'invalid') {
      const rows = await query<{ email: string; reason: string | null }>(
        `SELECT me.email_normalized AS email,
                COALESCE(vr.details->>'reason', vr.details->>'error') AS reason
         FROM validation_results vr
         JOIN master_emails me ON vr.master_id = me.id
         WHERE me.submitter_uuid = $1
           AND vr.status_enum = 'invalid'
           AND ($2::text = '' OR me.email_normalized ILIKE $2)
         ORDER BY vr.validated_at DESC
         LIMIT 500`,
        [employeeId, like]
      );
      return res.json(rows.rows);
    }

    // suppressed: combine personal domain exclusions + timeouts
    const personal = await query<{ email: string; reason: string }>(
      `SELECT me.email_normalized AS email, 'personal_domain' AS reason
       FROM personal_emails pe
       JOIN master_emails me ON pe.master_id = me.id
       WHERE me.submitter_uuid = $1
         AND ($2::text = '' OR me.email_normalized ILIKE $2)
       ORDER BY me.created_at DESC
       LIMIT 500`,
      [employeeId, like]
    );
    const timeouts = await query<{ email: string; reason: string }>(
      `SELECT me.email_normalized AS email, 'timeout' AS reason
       FROM validation_results vr
       JOIN master_emails me ON vr.master_id = me.id
       WHERE me.submitter_uuid = $1
         AND vr.status_enum = 'timeout'
         AND ($2::text = '' OR me.email_normalized ILIKE $2)
       ORDER BY vr.validated_at DESC
       LIMIT 500`,
      [employeeId, like]
    );
    return res.json([...personal.rows, ...timeouts.rows]);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'employee_results_failed', details: err.message });
  }
});

// Employee: overview for dashboard cards and progress chart
app.get('/employee/overview', async (req, res) => {
  try {
    const employeeId = String((req.query.employee_id || '').toString());
    if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });

    const totalFilesQ = await query('SELECT COUNT(*) FROM batches WHERE submitter_uuid=$1', [employeeId]);
    const totalEmailsQ = await query('SELECT COUNT(*) FROM master_emails WHERE submitter_uuid=$1', [employeeId]);

    const validQ = await query(
      `SELECT COUNT(*)
       FROM validation_results vr
       JOIN master_emails me ON vr.master_id = me.id
       WHERE me.submitter_uuid = $1
         AND vr.status_enum IN ('valid','catch_all')`,
      [employeeId]
    );

    const invalidQ = await query(
      `SELECT COUNT(*)
       FROM validation_results vr
       JOIN master_emails me ON vr.master_id = me.id
       WHERE me.submitter_uuid = $1
         AND vr.status_enum = 'invalid'`,
      [employeeId]
    );

    const timeoutQ = await query(
      `SELECT COUNT(*)
       FROM validation_results vr
       JOIN master_emails me ON vr.master_id = me.id
       WHERE me.submitter_uuid = $1
         AND vr.status_enum = 'timeout'`,
      [employeeId]
    );

    const personalQ = await query(
      `SELECT COUNT(*)
       FROM personal_emails pe
       JOIN master_emails me ON pe.master_id = me.id
       WHERE me.submitter_uuid = $1`,
      [employeeId]
    );

    const activeBatchesQ = await query(
      `SELECT COUNT(*)
       FROM batches b
       WHERE b.submitter_uuid = $1
         AND EXISTS (
           SELECT 1
           FROM master_emails me
           WHERE me.batch_id = b.batch_id
             AND NOT EXISTS (SELECT 1 FROM personal_emails pe WHERE pe.master_id = me.id)
             AND NOT EXISTS (SELECT 1 FROM validation_results vr WHERE vr.master_id = me.id)
         )`,
      [employeeId]
    );

    // Progress series for the most recent batch
    const latestBatchQ = await query(
      `SELECT batch_id FROM batches WHERE submitter_uuid=$1 ORDER BY created_at DESC LIMIT 1`,
      [employeeId]
    );

    let progress_series: Array<{ ts: string; progress: number }> = [];
    if (latestBatchQ.rows.length > 0) {
      const batchId = Number(latestBatchQ.rows[0].batch_id);
      const totalQ = await query('SELECT COUNT(*) FROM master_emails WHERE batch_id=$1', [batchId]);
      const total = Number(totalQ.rows[0]?.count || 0);
      if (total > 0) {
        const seriesQ = await query<{ ts: string; c: number }>(
          `SELECT date_trunc('minute', vr.validated_at) AS ts, COUNT(*) AS c
           FROM validation_results vr
           JOIN master_emails me ON vr.master_id = me.id
           WHERE me.batch_id = $1
           GROUP BY ts
           ORDER BY ts`,
          [batchId]
        );
        let cumulative = 0;
        progress_series = seriesQ.rows.map((r) => {
          cumulative += Number(r.c || 0);
          const pct = Math.round((cumulative / total) * 100);
          return { ts: new Date(r.ts).toISOString(), progress: pct };
        });
      }
    }

    res.json({
      total_files: Number(totalFilesQ.rows[0]?.count || 0),
      total_emails: Number(totalEmailsQ.rows[0]?.count || 0),
      valid: Number(validQ.rows[0]?.count || 0),
      invalid: Number(invalidQ.rows[0]?.count || 0),
      skipped: Number(personalQ.rows[0]?.count || 0) + Number(timeoutQ.rows[0]?.count || 0),
      active_batches: Number(activeBatchesQ.rows[0]?.count || 0),
      progress_series,
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'employee_overview_failed', details: err.message });
  }
});

app.get('/employee/validation-summary', async (req, res) => {
  try {
    const employeeId = String((req.query.employee_id || '').toString());
    if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });
    const rows = await query(
      `SELECT vr.category, vr.outcome, COUNT(*) AS c
       FROM validation_results vr
       JOIN master_emails me ON vr.master_id = me.id
       WHERE me.submitter_uuid = $1 AND COALESCE(vr.is_downloaded,false)=false
       GROUP BY vr.category, vr.outcome`,
      [employeeId]
    );
    const result: any = { business: { accepted: 0, catch_all: 0, rejected: 0, timeout: 0 }, personal: { accepted: 0, catch_all: 0, rejected: 0, timeout: 0 } };
    for (const r of rows.rows as any[]) {
      const cat = String(r.category || '').toLowerCase();
      const out = String(r.outcome || '').toLowerCase();
      const count = Number(r.c || 0);
      if (cat === 'business' && result.business[out] !== undefined) result.business[out] = count;
      if (cat === 'personal' && result.personal[out] !== undefined) result.personal[out] = count;
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'employee_validation_summary_failed', details: err.message });
  }
});

app.get('/employee/split-summary', async (req, res) => {
  try {
    const employeeId = String((req.query.employee_id || '').toString());
    if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });
    const biz = await query(
      `SELECT f.outcome, COUNT(*) AS c
       FROM final_business_emails f
       JOIN master_emails me ON f.master_id = me.id
       WHERE me.submitter_uuid = $1
       GROUP BY f.outcome`,
      [employeeId]
    );
    const per = await query(
      `SELECT f.outcome, COUNT(*) AS c
       FROM final_personal_emails f
       JOIN master_emails me ON f.master_id = me.id
       WHERE me.submitter_uuid = $1
       GROUP BY f.outcome`,
      [employeeId]
    );
    const result: any = { business: { accepted: 0, catch_all: 0, rejected: 0, timeout: 0 }, personal: { accepted: 0, catch_all: 0, rejected: 0, timeout: 0 } };
    for (const r of biz.rows as any[]) result.business[String(r.outcome || '')] = Number(r.c || 0);
    for (const r of per.rows as any[]) result.personal[String(r.outcome || '')] = Number(r.c || 0);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'employee_split_summary_failed', details: err.message });
  }
});

// Employee: validation results CSV export
app.get('/employee/results/export', async (req, res) => {
  try {
    const employeeId = String((req.query.employee_id || '').toString());
    const type = String((req.query.type || 'valid').toString()).toLowerCase();
    const q = String((req.query.q || '').toString());
    if (!employeeId) return res.status(400).send('missing_employee_id');
    const like = q ? `%${q}%` : '';

    let rows: { email: string; reason?: string | null }[] = [];
    if (type === 'valid') {
      const r = await query<{ email: string }>(
        `SELECT me.email_normalized AS email
         FROM validation_results vr
         JOIN master_emails me ON vr.master_id = me.id
         WHERE me.submitter_uuid = $1
           AND vr.status_enum IN ('valid','catch_all')
           AND ($2::text = '' OR me.email_normalized ILIKE $2)
         ORDER BY vr.validated_at DESC`,
        [employeeId, like]
      );
      rows = r.rows.map(x => ({ email: x.email }));
    } else if (type === 'invalid') {
      const r = await query<{ email: string; reason: string | null }>(
        `SELECT me.email_normalized AS email,
                COALESCE(vr.details->>'reason', vr.details->>'error') AS reason
         FROM validation_results vr
         JOIN master_emails me ON vr.master_id = me.id
         WHERE me.submitter_uuid = $1
           AND vr.status_enum = 'invalid'
           AND ($2::text = '' OR me.email_normalized ILIKE $2)
         ORDER BY vr.validated_at DESC`,
        [employeeId, like]
      );
      rows = r.rows.map(x => ({ email: x.email, reason: x.reason }));
    } else {
      const personal = await query<{ email: string; reason: string }>(
        `SELECT me.email_normalized AS email, 'personal_domain' AS reason
         FROM personal_emails pe
         JOIN master_emails me ON pe.master_id = me.id
         WHERE me.submitter_uuid = $1
           AND ($2::text = '' OR me.email_normalized ILIKE $2)
         ORDER BY me.created_at DESC`,
        [employeeId, like]
      );
      const timeouts = await query<{ email: string; reason: string }>(
        `SELECT me.email_normalized AS email, 'timeout' AS reason
         FROM validation_results vr
         JOIN master_emails me ON vr.master_id = me.id
         WHERE me.submitter_uuid = $1
           AND vr.status_enum = 'timeout'
           AND ($2::text = '' OR me.email_normalized ILIKE $2)
         ORDER BY vr.validated_at DESC`,
        [employeeId, like]
      );
      rows = [...personal.rows, ...timeouts.rows].map(x => ({ email: x.email, reason: x.reason }));
    }

    const header = 'email,reason\n';
    const body = rows.map(r => `${r.email},${(r.reason || '').replace(/\n|\r|,/g, ' ')}`).join('\n');
    const csv = header + body;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
    res.send(csv);
  } catch (err: any) {
    console.error(err);
    res.status(500).send('employee_results_export_failed');
  }
});

app.get('/employee/validation/download/all', async (req, res) => {
  try {
    const { id: employeeUuid, role } = getSupabaseUser(req);
    const batchId = Number((req.query.batch_id || 0));
    if (!employeeUuid || !batchId) return res.status(400).send('missing_employee_or_batch');
    const b = await query<{ submitter_uuid: string | null }>('SELECT submitter_uuid FROM batches WHERE batch_id=$1', [batchId]);
    const owner = String(b.rows[0]?.submitter_uuid || '');
    if (String(role || '').toLowerCase() !== 'admin' && owner !== String(employeeUuid)) return res.status(403).send('forbidden');
    const groups = [
      { category: 'business', outcome: 'accepted' },
      { category: 'business', outcome: 'catch_all' },
      { category: 'business', outcome: 'rejected' },
      { category: 'personal', outcome: 'accepted' },
      { category: 'personal', outcome: 'catch_all' },
      { category: 'personal', outcome: 'rejected' }
    ];
    const allRows: { id: number; email: string; domain: string | null; status: string; category: string; first_found_at: string | null; batch_id: number; validated_at: string | null }[] = [];
    for (const g of groups) {
      const q = await query<{ id: number; email: string; domain: string | null; status: string; category: string; first_found_at: string | null; batch_id: number; validated_at: string | null }>(
        `SELECT vr.id,
                me.email_normalized AS email,
                COALESCE(vr.domain, me.domain) AS domain,
                vr.outcome AS status,
                vr.category AS category,
                me.first_seen_at AS first_found_at,
                me.batch_id AS batch_id,
                vr.validated_at AS validated_at
         FROM validation_results vr
         JOIN master_emails me ON vr.master_id = me.id
         WHERE me.batch_id=$1 AND vr.category=$2 AND vr.outcome=$3 AND COALESCE(vr.is_downloaded,false)=false
         ORDER BY vr.validated_at DESC`,
        [batchId, g.category, g.outcome]
      );
      allRows.push(...q.rows);
    }
    if (allRows.length === 0) return res.status(400).send('no_rows');
    const ids = allRows.map(r => r.id);
    const header = 'email,domain,status,category,first_found_at,batch_id,validated_at,downloaded_at\n';
    const ts = new Date().toISOString();
    const body = allRows.map(r => `${r.email || ''},${r.domain || ''},${r.status || ''},${r.category || ''},${r.first_found_at ? new Date(r.first_found_at).toISOString() : ''},${r.batch_id},${r.validated_at ? new Date(r.validated_at).toISOString() : ''},${ts}`).join('\n');
    const csv = header + body;
    const dir = require('path').join(require('../config').config.downloadDir, String(employeeUuid), String(batchId), String(Date.now()));
    require('fs').mkdirSync(dir, { recursive: true });
    const file = require('path').join(dir, `all.csv`);
    require('fs').writeFileSync(file, csv);
    await query('BEGIN');
    await query('UPDATE validation_results SET is_downloaded=true, downloaded_at=now(), downloaded_batch_id=$2, downloaded_by=$3 WHERE id = ANY($1::bigint[])', [ids, batchId, employeeUuid]);
    await query('INSERT INTO download_history(batch_id, employee_uuid, download_type, file_path, total_downloaded) VALUES ($1, $2, $3, $4, $5)', [batchId, employeeUuid, 'all', file, allRows.length]);
    await query('COMMIT');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="batch_${batchId}_all.csv"`);
    res.send(csv);
  } catch (err: any) {
    try { await query('ROLLBACK'); } catch {}
    res.status(500).send('employee_download_all_failed');
  }
});

app.get('/employee/validation/download/:type', async (req, res) => {
  try {
    const { id: employeeUuid, role } = getSupabaseUser(req);
    const batchId = Number((req.query.batch_id || 0));
    const type = String(req.params.type || '').toLowerCase();
    if (!employeeUuid || !batchId) return res.status(400).send('missing_employee_or_batch');
    const b = await query<{ submitter_uuid: string | null }>('SELECT submitter_uuid FROM batches WHERE batch_id=$1', [batchId]);
    const owner = String(b.rows[0]?.submitter_uuid || '');
    if (String(role || '').toLowerCase() !== 'admin' && owner !== String(employeeUuid)) return res.status(403).send('forbidden');
    const map: Record<string, { category: string; outcome: string; name: string }> = {
      'business_accepted': { category: 'business', outcome: 'accepted', name: 'business_accepted' },
      'business_catch_all': { category: 'business', outcome: 'catch_all', name: 'business_catch_all' },
      'business_catchall': { category: 'business', outcome: 'catch_all', name: 'business_catch_all' },
      'business_rejected': { category: 'business', outcome: 'rejected', name: 'business_rejected' },
      'personal_accepted': { category: 'personal', outcome: 'accepted', name: 'personal_accepted' },
      'personal_catch_all': { category: 'personal', outcome: 'catch_all', name: 'personal_catch_all' },
      'personal_catchall': { category: 'personal', outcome: 'catch_all', name: 'personal_catch_all' },
      'personal_rejected': { category: 'personal', outcome: 'rejected', name: 'personal_rejected' }
    };
    const sel = map[type];
    if (!sel) return res.status(400).send('invalid_type');
    const rows = await query<{ id: number; email: string; domain: string | null; status: string; category: string; first_found_at: string | null; batch_id: number; validated_at: string | null }>(
      `SELECT vr.id,
              me.email_normalized AS email,
              COALESCE(vr.domain, me.domain) AS domain,
              vr.outcome AS status,
              vr.category AS category,
              me.first_seen_at AS first_found_at,
              me.batch_id AS batch_id,
              vr.validated_at AS validated_at
       FROM validation_results vr
       JOIN master_emails me ON vr.master_id = me.id
       WHERE me.batch_id=$1 AND vr.category=$2 AND vr.outcome=$3 AND COALESCE(vr.is_downloaded,false)=false
       ORDER BY vr.validated_at DESC`,
      [batchId, sel.category, sel.outcome]
    );
    if (rows.rows.length === 0) return res.status(400).send('no_rows');
    const ids = rows.rows.map(r => r.id);
    const header = 'email,domain,status,category,first_found_at,batch_id,validated_at,downloaded_at\n';
    const ts = new Date().toISOString();
    const body = rows.rows.map(r => `${r.email || ''},${r.domain || ''},${r.status || ''},${r.category || ''},${r.first_found_at ? new Date(r.first_found_at).toISOString() : ''},${r.batch_id},${r.validated_at ? new Date(r.validated_at).toISOString() : ''},${ts}`).join('\n');
    const csv = header + body;
    const dir = require('path').join(require('../config').config.downloadDir, String(employeeUuid), String(batchId), String(Date.now()));
    require('fs').mkdirSync(dir, { recursive: true });
    const file = require('path').join(dir, `${sel.name}.csv`);
    require('fs').writeFileSync(file, csv);
    await query('BEGIN');
    await query('UPDATE validation_results SET is_downloaded=true, downloaded_at=now(), downloaded_batch_id=$2, downloaded_by=$3 WHERE id = ANY($1::bigint[])', [ids, batchId, employeeUuid]);
    await query('INSERT INTO download_history(batch_id, employee_uuid, download_type, file_path, total_downloaded) VALUES ($1, $2, $3, $4, $5)', [batchId, employeeUuid, sel.name, file, rows.rows.length]);
    await query('COMMIT');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="batch_${batchId}_${sel.name}.csv"`);
    res.send(csv);
  } catch (err: any) {
    try { await query('ROLLBACK'); } catch {}
    res.status(500).send('employee_download_type_failed');
  }
});

app.post('/employee/validation/mark-downloaded', async (req, res) => {
  try {
    const { id: employeeUuid, role } = getSupabaseUser(req);
    const { batch_id, email_ids, download_type, file_path } = req.body || {};
    const batchId = Number(batch_id || 0);
    const ids = Array.isArray(email_ids) ? email_ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0) : [];
    const type = String(download_type || '');
    if (!employeeUuid || !batchId || ids.length === 0 || !type) return res.status(400).json({ error: 'invalid_body' });
    const b = await query<{ submitter_uuid: string | null }>('SELECT submitter_uuid FROM batches WHERE batch_id=$1', [batchId]);
    const owner = String(b.rows[0]?.submitter_uuid || '');
    if (String(role || '').toLowerCase() !== 'admin' && owner !== String(employeeUuid)) return res.status(403).json({ error: 'forbidden' });
    await query('BEGIN');
    await query('UPDATE validation_results SET is_downloaded=true, downloaded_at=now(), downloaded_batch_id=$2, downloaded_by=$3 WHERE id = ANY($1::bigint[])', [ids, batchId, employeeUuid]);
    await query('INSERT INTO download_history(batch_id, employee_uuid, download_type, file_path, total_downloaded) VALUES ($1, $2, $3, $4, $5)', [batchId, employeeUuid, type, String(file_path || ''), ids.length]);
    await query('COMMIT');
    res.json({ ok: true, marked: ids.length });
  } catch (err: any) {
    try { await query('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'employee_mark_downloaded_failed', details: err.message });
  }
});

app.get('/employee/download-history', async (req, res) => {
  try {
    const { id: employeeUuid, role } = getSupabaseUser(req);
    const page = Math.max(1, Number((req.query.page || 1)));
    const pageSize = Math.min(100, Math.max(1, Number((req.query.page_size || 20))));
    const batchId = Number((req.query.batch_id || 0));
    const type = String((req.query.type || '')).toLowerCase();
    const start = String((req.query.start_date || ''));
    const end = String((req.query.end_date || ''));
    const isAdmin = String(role || '').toLowerCase() === 'admin';
    const params: any[] = [];
    let sql = `SELECT id, batch_id, employee_uuid, download_type, file_path, total_downloaded, created_at FROM download_history`;
    const where: string[] = [];
    if (!isAdmin) { where.push(`employee_uuid=$${params.length + 1}`); params.push(employeeUuid); }
    if (batchId) { where.push(`batch_id=$${params.length + 1}`); params.push(batchId); }
    if (type) { where.push(`download_type=$${params.length + 1}`); params.push(type); }
    if (start) { where.push(`created_at >= $${params.length + 1}`); params.push(new Date(start)); }
    if (end) { where.push(`created_at <= $${params.length + 1}`); params.push(new Date(end)); }
    if (where.length) sql += ` WHERE ` + where.join(' AND ');
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(pageSize, (page - 1) * pageSize);
    const rows = await query(sql, params);
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'employee_download_history_failed', details: err.message });
  }
});

app.get('/employee/download-history/file/:id', async (req, res) => {
  try {
    const { id: employeeUuid, role } = getSupabaseUser(req);
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).send('invalid_id');
    const row = await query<{ file_path: string; employee_uuid: string }>('SELECT file_path, employee_uuid FROM download_history WHERE id=$1', [id]);
    if (row.rowCount === 0) return res.status(404).send('not_found');
    const owner = String(row.rows[0].employee_uuid || '');
    if (String(role || '').toLowerCase() !== 'admin' && owner !== String(employeeUuid)) return res.status(403).send('forbidden');
    const fp = String(row.rows[0].file_path || '');
    const fs = require('fs');
    if (!fp || !fs.existsSync(fp)) return res.status(404).send('file_missing');
    const path = require('path');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(fp)}"`);
    res.send(fs.readFileSync(fp));
  } catch (err: any) {
    res.status(500).send('employee_download_history_file_failed');
  }
});

// Employee: activity logs (basic)
app.get('/employee/logs', async (req, res) => {
  try {
    // Note: audit_logs uses BIGINT actor_id; Supabase UUID is not directly stored yet.
    // For now, return recent system logs. Future enhancement: link actor UUIDs to logs.
    const rows = await query<{ created_at: string; action_type: string; details: any }>(
      `SELECT created_at, action_type, details FROM audit_logs ORDER BY created_at DESC LIMIT 100`
    );
    const result = rows.rows.map(r => ({
      time: r.created_at,
      action: r.action_type,
      status: '',
      message: (r.details && (r.details.message || r.details.error)) || ''
    }));
    res.json(result);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'employee_logs_failed', details: err.message });
  }
});

// Admin: batches list with progress stats
app.get('/admin/batches', async (_req, res) => {
  try {
    const batches = await query('SELECT * FROM batches ORDER BY created_at DESC');
    const result = [] as any[];
    for (const b of batches.rows as any[]) {
      const id = b.batch_id;
      const staged = await query('SELECT COUNT(*) FROM master_emails_temp WHERE batch_id=$1', [id]);
      const master = await query('SELECT COUNT(*) FROM master_emails WHERE batch_id=$1', [id]);
      const filtered = await query('SELECT COUNT(*) FROM filter_emails fe JOIN master_emails me ON fe.master_id=me.id WHERE me.batch_id=$1', [id]);
      const filtered_rules = await query(
        `SELECT COUNT(*)
         FROM filter_emails fe
         JOIN master_emails me ON fe.master_id = me.id
         WHERE me.batch_id = $1
           AND (
             COALESCE((fe.filter_flags->>'domain')::boolean, false)
             OR COALESCE((fe.filter_flags->>'contains')::boolean, false)
             OR COALESCE((fe.filter_flags->>'endswith')::boolean, false)
             OR COALESCE((fe.filter_flags->>'excluded')::boolean, false)
           )`,
        [id]
      );
      const filtered_unsub = await query(
        `SELECT COUNT(*)
         FROM filter_emails fe
         JOIN master_emails me ON fe.master_id = me.id
         WHERE me.batch_id = $1
           AND COALESCE((fe.filter_flags->>'unsubscribed')::boolean, false)`,
        [id]
      );
      const personal = await query('SELECT COUNT(*) FROM personal_emails pe JOIN master_emails me ON pe.master_id=me.id WHERE me.batch_id=$1', [id]);
      const validated = await query('SELECT COUNT(*) FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1', [id]);
      const total = Number((b?.total_count ?? 0) as number);
      const stagedCount = Number(staged.rows[0].count || 0);
      const masterCount = Number(master.rows[0].count || 0);
      const duplicates = Math.max(0, total - stagedCount - masterCount);
      result.push({
        batch: b,
        counts: {
          staged: stagedCount,
          master: masterCount,
          filtered: Number(filtered.rows[0].count || 0),
          filtered_rules: Number(filtered_rules.rows[0].count || 0),
          filtered_unsub: Number(filtered_unsub.rows[0].count || 0),
          personal: Number(personal.rows[0].count || 0),
          validated: Number(validated.rows[0].count || 0),
          duplicates
        }
      });
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_batches_failed', details: err.message });
  }
});

// Admin: employees summary
app.get('/admin/employees', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT submitter_id AS employee_id,
              COUNT(*) FILTER (WHERE me.id IS NOT NULL) AS uploads,
              COUNT(vr.id) AS validated
       FROM batches b
       LEFT JOIN master_emails me ON me.batch_id = b.batch_id
       LEFT JOIN validation_results vr ON vr.master_id = me.id
       GROUP BY submitter_id
       ORDER BY uploads DESC`
    );
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_employees_failed', details: err.message });
  }
});

// Admin: rules CRUD
app.get('/admin/rules', async (req, res) => {
  const { scope, employee_id, team_id } = req.query;
  try {
    const rows = await query(
      `SELECT * FROM rules
       WHERE ($1::text IS NULL OR scope=$1)
         AND ($2::bigint IS NULL OR employee_id=$2)
         AND ($3::bigint IS NULL OR team_id=$3)
       ORDER BY updated_at DESC`,
      [scope || null, employee_id || null, team_id || null]
    );
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_rules_list_failed', details: err.message });
  }
});

app.post('/admin/rules', async (req, res) => {
  try {
    const { scope, employee_id, team_id, contains, endswith, domains, excludes, priority } = req.body || {};
    const row = await query(
      `INSERT INTO rules(scope, employee_id, team_id, contains, endswith, domains, excludes, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        scope || 'employee',
        employee_id || null,
        team_id || null,
        JSON.stringify(contains || []),
        JSON.stringify(endswith || []),
        JSON.stringify(domains || []),
        JSON.stringify(excludes || []),
        priority || 0
      ]
    );
    await query('INSERT INTO audit_logs(action_type, details) VALUES ($1, $2)', ['rules_create', JSON.stringify({ id: row.rows[0].id })]);
    res.json(row.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_rules_create_failed', details: err.message });
  }
});

app.put('/admin/rules/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { contains, endswith, domains, excludes, priority } = req.body || {};
    const row = await query(
      `UPDATE rules SET contains=$2, endswith=$3, domains=$4, excludes=$5, priority=$6, updated_at=now() WHERE id=$1 RETURNING *`,
      [
        id,
        JSON.stringify(contains || []),
        JSON.stringify(endswith || []),
        JSON.stringify(domains || []),
        JSON.stringify(excludes || []),
        priority || 0
      ]
    );
    await query('INSERT INTO audit_logs(action_type, resource_ref, details) VALUES ($1, $2, $3)', ['rules_update', `rule:${id}`, JSON.stringify({ id })]);
    res.json(row.rows[0] || null);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_rules_update_failed', details: err.message });
  }
});

app.delete('/admin/rules/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await query('DELETE FROM rules WHERE id=$1', [id]);
    await query('INSERT INTO audit_logs(action_type, resource_ref) VALUES ($1, $2)', ['rules_delete', `rule:${id}`]);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_rules_delete_failed', details: err.message });
  }
});

// Admin: overview stats
app.get('/admin/overview', async (_req, res) => {
  try {
    const totalBatches = await query('SELECT COUNT(*) FROM batches');
    const totalMaster = await query('SELECT COUNT(*) FROM master_emails');
    const totalPersonal = await query('SELECT COUNT(*) FROM personal_emails');
    const valStats = await query(
      `SELECT 
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status_enum = 'deliverable') AS ok
       FROM validation_results`
    );
    const employees = await query('SELECT COUNT(DISTINCT submitter_id) FROM batches WHERE submitter_id IS NOT NULL');

    const total = Number(valStats.rows[0]?.total || 0);
    const ok = Number(valStats.rows[0]?.ok || 0);
    const validation_success_rate = total > 0 ? Math.round((ok / total) * 100) : 0;
    const personal = Number(totalPersonal.rows[0]?.count || 0);
    const corporate = Math.max(0, Number(totalMaster.rows[0]?.count || 0) - personal);

    res.json({
      total_batches: Number(totalBatches.rows[0]?.count || 0),
      in_progress: Number(totalBatches.rows[0]?.count || 0), // placeholder until per-batch status is tracked
      failed_jobs: 0, // placeholder; no error tracking table yet
      validation_success_rate,
      active_employees: Number(employees.rows[0]?.count || 0),
      domains: { corporate, personal }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_overview_failed', details: err.message });
  }
});

// Admin: users list
app.get('/admin/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const rows = await query(
      `SELECT id, email, full_name, avatar_url, role, created_at, updated_at
       FROM profiles
       ORDER BY created_at DESC`
    );
    res.json(rows.rows);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'admin_users_list_failed', details: err.message });
  }
});

// Admin: create user
app.post('/admin/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { email, password, full_name, role } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_password_required' });
    }
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'supabase_admin_not_configured' });
    }
    // Create auth user
    const normalizedRole = role ? String(role).toLowerCase() : undefined;
    const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // auto-verify so no email verification is required
      user_metadata: { full_name: full_name || null },
      app_metadata: normalizedRole ? { role: normalizedRole } : undefined,
    });
    if (cErr) throw cErr;
    const userId = created?.user?.id as string;
    // Mirror role into profiles immediately for server-side reads
    if (normalizedRole) {
      await query('UPDATE profiles SET role=$2, updated_at=now() WHERE id=$1', [userId, normalizedRole]);
    }
    // Return profile row (trigger should have inserted on user create; fallback select)
    const prof = await query('SELECT id, email, full_name, avatar_url, role, created_at, updated_at FROM profiles WHERE id=$1', [userId]);
    await query('INSERT INTO audit_logs(action_type, actor_id, details) VALUES ($1, $2, $3)', ['admin_user_create', null, JSON.stringify({ id: userId, email })]);
    res.json({ user_id: userId, profile: prof.rows[0] || null });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'admin_user_create_failed', details: err.message });
  }
});

// Admin: update user role
app.put('/admin/users/:id/role', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.params.id || '');
    const { role } = req.body || {};
    const normalized = String(role || '').toLowerCase();
    if (!id || !['admin','collector','employee'].includes(normalized)) {
      return res.status(400).json({ error: 'invalid_role_or_user' });
    }
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'supabase_admin_not_configured' });
    }
    // Update app_metadata.role for future JWTs
    const { error: uErr } = await supabaseAdmin.auth.admin.updateUserById(id, {
      app_metadata: { role: normalized },
    });
    if (uErr) throw uErr;
    // Mirror into profiles for server-side reads
    await query('UPDATE profiles SET role=$2, updated_at=now() WHERE id=$1', [id, normalized]);
    await query('INSERT INTO audit_logs(action_type, actor_id, resource_ref, details) VALUES ($1, $2, $3, $4)', ['admin_user_role_update', null, `user:${id}`, JSON.stringify({ role: normalized })]);
    res.json({ ok: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'admin_user_role_update_failed', details: err.message });
  }
});

// Admin: control actions (stub)
app.post('/admin/control/:action', async (req, res) => {
  try {
    const action = String(req.params.action || '').toLowerCase();
    // Publish a control message for future consumers; currently informational
    await publish(CHANNELS.batchProgress, { stage: 'admin_control', action });
    res.json({ ok: true, action });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_control_failed', details: err.message });
  }
});

// Admin: unsubscribes
app.get('/admin/unsubscribes/emails', async (_req, res) => {
  try {
    const rows = await query('SELECT * FROM unsubscribe_list ORDER BY added_at DESC');
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_unsub_emails_list_failed', details: err.message });
  }
});

app.get('/admin/unsubscribes/domains', async (_req, res) => {
  try {
    const rows = await query('SELECT * FROM unsubscribe_domains ORDER BY added_at DESC');
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_unsub_domains_list_failed', details: err.message });
  }
});

app.post('/admin/unsubscribes/emails', async (req, res) => {
  try {
    const { emails, user_id } = req.body || {};
    if (!Array.isArray(emails) || emails.length === 0)
      return res.status(400).json({ error: 'emails_required' });
    const values = emails.map((e, i) => `($${i + 1}, ${user_id || 'NULL'})`).join(',');
    await query(`INSERT INTO unsubscribe_list(email, added_by) VALUES ${values} ON CONFLICT (email) DO NOTHING`, emails);
    await query('INSERT INTO audit_logs(action_type, actor_id, details) VALUES ($1, $2, $3)', ['unsub_emails_upload', user_id || null, JSON.stringify({ count: emails.length })]);
    res.json({ inserted: emails.length });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_unsub_emails_upload_failed', details: err.message });
  }
});

app.post('/admin/unsubscribes/domains', async (req, res) => {
  try {
    const { domains, user_id } = req.body || {};
    if (!Array.isArray(domains) || domains.length === 0)
      return res.status(400).json({ error: 'domains_required' });
    const values = domains.map((d, i) => `($${i + 1}, ${user_id || 'NULL'})`).join(',');
    await query(`INSERT INTO unsubscribe_domains(domain, added_by) VALUES ${values} ON CONFLICT (domain) DO NOTHING`, domains);
    await query('INSERT INTO audit_logs(action_type, actor_id, details) VALUES ($1, $2, $3)', ['unsub_domains_upload', user_id || null, JSON.stringify({ count: domains.length })]);
    res.json({ inserted: domains.length });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_unsub_domains_upload_failed', details: err.message });
  }
});

// Employee: unsubscribe emails (single or bulk)
app.post('/employee/unsubscribes/emails', async (req, res) => {
  try {
    const { emails, reason, campaign, employee_id } = req.body || {};
    const { id: supaId } = getSupabaseUser(req);
    const employeeUuid = String(employee_id || supaId || '');
    const list = Array.isArray(emails) ? emails : (typeof emails === 'string' ? [emails] : []);
    if (list.length === 0) return res.status(400).json({ error: 'emails_required' });

    // Insert global unsub entries with optional metadata and uuid tracking
    const placeholders = list.map((_, i) => `($${i + 1}, $${list.length + 1}, $${list.length + 2}, $${list.length + 3})`).join(',');
    await query(
      `INSERT INTO unsubscribe_list(email, reason, campaign, added_by_uuid)
       VALUES ${placeholders}
       ON CONFLICT (email) DO NOTHING`,
      [...list, (reason || null), (campaign || null), employeeUuid || null]
    );

    // Log per-employee actions
    for (const e of list) {
      await query(
        `INSERT INTO unsubscribe_actions(email, employee_uuid, reason, campaign)
         VALUES ($1, $2, $3, $4)`,
        [e, employeeUuid || null, reason || null, campaign || null]
      );
    }

    await query('INSERT INTO audit_logs(action_type, actor_id, details) VALUES ($1, $2, $3)', ['employee_unsub_emails', null, JSON.stringify({ employee_uuid: employeeUuid, count: list.length })]);
    res.json({ inserted: list.length });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'employee_unsub_emails_failed', details: err.message });
  }
});

// Employee: unsubscribe domains (bulk)
app.post('/employee/unsubscribes/domains', async (req, res) => {
  try {
    const { domains, employee_id } = req.body || {};
    const { id: supaId } = getSupabaseUser(req);
    const employeeUuid = String(employee_id || supaId || '');
    const list = Array.isArray(domains) ? domains : (typeof domains === 'string' ? [domains] : []);
    if (list.length === 0) return res.status(400).json({ error: 'domains_required' });

    const placeholders = list.map((_, i) => `($${i + 1}, $${list.length + 1})`).join(',');
    await query(
      `INSERT INTO unsubscribe_domains(domain, added_by_uuid)
       VALUES ${placeholders}
       ON CONFLICT (domain) DO NOTHING`,
      [...list, employeeUuid || null]
    );

    for (const d of list) {
      await query(
        `INSERT INTO unsubscribe_actions(domain, employee_uuid)
         VALUES ($1, $2)`,
        [d, employeeUuid || null]
      );
    }
    await query('INSERT INTO audit_logs(action_type, actor_id, details) VALUES ($1, $2, $3)', ['employee_unsub_domains', null, JSON.stringify({ employee_uuid: employeeUuid, count: list.length })]);
    res.json({ inserted: list.length });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'employee_unsub_domains_failed', details: err.message });
  }
});

// Employee: fetch own unsubscribe history (emails and domains)
app.get('/employee/unsubscribes/history', async (req, res) => {
  try {
    const employeeUuid = String((req.query.employee_id || '').toString());
    if (!employeeUuid) return res.status(400).json({ error: 'employee_id_required' });
    const emails = await query(
      `SELECT email, reason, campaign, added_at
       FROM unsubscribe_actions
       WHERE employee_uuid = $1 AND email IS NOT NULL
       ORDER BY added_at DESC
       LIMIT 500`,
      [employeeUuid]
    );
    const domains = await query(
      `SELECT domain, added_at
       FROM unsubscribe_actions
       WHERE employee_uuid = $1 AND domain IS NOT NULL
       ORDER BY added_at DESC
       LIMIT 500`,
      [employeeUuid]
    );
    res.json({ emails: emails.rows, domains: domains.rows });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'employee_unsub_history_failed', details: err.message });
  }
});

// Employee: process a pasted/uploaded list and filter out unsubscribed emails/domains
app.post('/employee/filter/unsub/process', async (req, res) => {
  try {
    const { emails } = req.body || {};
    const list = Array.isArray(emails) ? emails : (typeof emails === 'string' ? [emails] : []);
    if (list.length === 0) return res.status(400).json({ error: 'emails_required' });
    // Normalize a bit: trim and lowercase
    const cleaned = list.map((e: string) => (e || '').trim()).filter(Boolean);
    // Load unsub tables
    const unsubEmailsQ = await query<{ email: string }>('SELECT email FROM unsubscribe_list');
    const unsubDomainsQ = await query<{ domain: string }>('SELECT domain FROM unsubscribe_domains');
    const unsubEmails = new Set(unsubEmailsQ.rows.map(r => r.email.toLowerCase()));
    const unsubDomains = new Set(unsubDomainsQ.rows.map(r => r.domain.toLowerCase()));
    const kept: string[] = [];
    const filteredOut: string[] = [];
    for (const raw of cleaned) {
      const lc = raw.toLowerCase();
      const at = lc.indexOf('@');
      const domain = at >= 0 ? lc.slice(at + 1) : '';
      const isUnsub = unsubEmails.has(lc) || (domain && unsubDomains.has(domain));
      if (isUnsub) filteredOut.push(raw); else kept.push(raw);
    }
    res.json({ kept, filtered_out: filteredOut, counts: { kept: kept.length, filtered: filteredOut.length } });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'employee_filter_unsub_failed', details: err.message });
  }
});

// Free pool summary for employee dashboard
app.get('/free-pool/summary', async (req, res) => {
  try {
    const employeeId = String((req.query.employee_id || '').toString());
    const settings = await query<{ daily_free_pool_limit: number }>('SELECT daily_free_pool_limit FROM system_settings ORDER BY updated_at DESC LIMIT 1');
    const limit = Number(settings.rows[0]?.daily_free_pool_limit || 200);
    const availableQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM free_pool WHERE is_assigned=false');
    let assignedToday = 0;
    if (employeeId) {
      const assignedTodayQ = await query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM free_pool WHERE assigned_to_uuid=$1 AND is_assigned=true AND assigned_at::date = CURRENT_DATE`,
        [employeeId]
      );
      assignedToday = Number(assignedTodayQ.rows[0]?.c || 0);
    }
    res.json({ limit, available: Number(availableQ.rows[0]?.c || 0), assigned_today: assignedToday });
  } catch (err: any) {
    res.status(500).json({ error: 'free_pool_summary_failed', details: err.message });
  }
});

// Free pool availability breakdown (accepted/catch_all only)
app.get('/free-pool/available', async (_req, res) => {
  try {
    const bAcc = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM free_pool WHERE is_assigned=false AND category='business' AND outcome='accepted'`);
    const bCat = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM free_pool WHERE is_assigned=false AND category='business' AND outcome='catch_all'`);
    const pAcc = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM free_pool WHERE is_assigned=false AND category='personal' AND outcome='accepted'`);
    const pCat = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM free_pool WHERE is_assigned=false AND category='personal' AND outcome='catch_all'`);
    res.json({
      business_accepted: Number(bAcc.rows[0]?.c || 0),
      business_catch_all: Number(bCat.rows[0]?.c || 0),
      personal_accepted: Number(pAcc.rows[0]?.c || 0),
      personal_catch_all: Number(pCat.rows[0]?.c || 0),
      total: Number(bAcc.rows[0]?.c || 0) + Number(bCat.rows[0]?.c || 0) + Number(pAcc.rows[0]?.c || 0) + Number(pCat.rows[0]?.c || 0)
    });
  } catch (err: any) {
    res.status(500).json({ error: 'free_pool_available_failed', details: err.message });
  }
});

// Free pool assign action
app.post('/free-pool/assign', async (req, res) => {
  try {
    const employeeId = String((req.body?.employee_id || '').toString());
    if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });
    const settings = await query<{ daily_free_pool_limit: number }>('SELECT daily_free_pool_limit FROM system_settings ORDER BY updated_at DESC LIMIT 1');
    const limit = Number(settings.rows[0]?.daily_free_pool_limit || 200);
    const requested = req.body?.request || {};
    const rBizAcc = Number(requested.business_accepted || 0);
    const rBizCat = Number(requested.business_catch_all || 0);
    const rPerAcc = Number(requested.personal_accepted || 0);
    const rPerCat = Number(requested.personal_catch_all || 0);
    const sumReq = rBizAcc + rBizCat + rPerAcc + rPerCat;
    if (sumReq > 0 && sumReq !== limit) return res.status(400).json({ error: 'request_must_equal_limit', limit, requested: sumReq });
    const alreadyQ = await query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM free_pool WHERE assigned_to_uuid=$1 AND is_assigned=true AND assigned_at::date = CURRENT_DATE`,
      [employeeId]
    );
    if (Number(alreadyQ.rows[0]?.c || 0) >= 1) return res.status(400).json({ error: 'already_assigned_today' });

    async function take(category: string, outcome: string, n: number) {
      if (n <= 0) return [] as any[];
      const q = await query<{ id: number; email: string; domain: string | null; category: string | null; outcome: string | null }>(
        `SELECT id, email, domain, category, outcome FROM free_pool WHERE is_assigned=false AND category=$1 AND outcome=$2 ORDER BY id LIMIT $3`,
        [category, outcome, n]
      );
      return q.rows;
    }

    let rows: any[] = [];
    if (sumReq === limit) {
      const bizAcc = await take('business', 'accepted', rBizAcc);
      const bizCat = await take('business', 'catch_all', rBizCat);
      const perAcc = await take('personal', 'accepted', rPerAcc);
      const perCat = await take('personal', 'catch_all', rPerCat);
      if (bizAcc.length < rBizAcc || bizCat.length < rBizCat || perAcc.length < rPerAcc || perCat.length < rPerCat) {
        return res.status(400).json({ error: 'not_enough_per_type', details: { bizAcc: bizAcc.length, bizCat: bizCat.length, perAcc: perAcc.length, perCat: perCat.length } });
      }
      rows = [...bizAcc, ...bizCat, ...perAcc, ...perCat];
    } else {
      const anyQ = await query<{ id: number; email: string; domain: string | null; category: string | null; outcome: string | null }>(
        `SELECT id, email, domain, category, outcome
         FROM free_pool
         WHERE is_assigned=false AND outcome IN ('accepted','catch_all')
         ORDER BY id
         LIMIT $1`,
        [limit]
      );
      rows = anyQ.rows;
      if (rows.length < limit) return res.status(400).json({ error: 'not_enough_free_pool', available: rows.length, required: limit });
    }

    const ids = rows.map(r => r.id);
    await query('BEGIN');
    await query('UPDATE free_pool SET is_assigned=true, assigned_to_uuid=$2, assigned_at=now() WHERE id = ANY($1::bigint[])', [ids, employeeId]);
    for (const r of rows) {
      const email = String(r.email || '');
      const domain = r.domain || null;
      const outcome = ['accepted','catch_all','rejected','timeout'].includes(String(r.outcome || '')) ? String(r.outcome) : 'accepted';
      if (String(r.category || '') === 'personal') {
        await query('INSERT INTO final_personal_emails(batch_id, master_id, email, domain, outcome, assigned_from_free_pool) VALUES (NULL, NULL, $1, $2, $3, true)', [email, domain, outcome]);
      } else {
        await query('INSERT INTO final_business_emails(batch_id, master_id, email, domain, outcome, assigned_from_free_pool) VALUES (NULL, NULL, $1, $2, $3, true)', [email, domain, outcome]);
      }
    }
    await query('INSERT INTO free_pool_assignments(employee_uuid, business_accepted, business_catch_all, personal_accepted, personal_catch_all, total) VALUES ($1, $2, $3, $4, $5, $6)', [employeeId, rBizAcc, rBizCat, rPerAcc, rPerCat, limit]);
    await query('COMMIT');
    await publish(CHANNELS.batchProgress, { stage: 'free_pool_assigned', count: ids.length });
    res.json({ assigned: ids.length });
  } catch (err: any) {
    try { await query('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'free_pool_assign_failed', details: err.message });
  }
});

// Free pool assignment history
app.get('/free-pool/assignments', async (req, res) => {
  try {
    const employeeId = String((req.query.employee_id || '').toString());
    if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });
    const rows = await query(
      `SELECT employee_uuid, business_accepted, business_catch_all, personal_accepted, personal_catch_all, total, created_at
       FROM free_pool_assignments
       WHERE employee_uuid=$1
       ORDER BY created_at DESC
       LIMIT 100`,
      [employeeId]
    );
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'free_pool_assignments_failed', details: err.message });
  }
});

// Admin free pool settings
app.get('/admin/free-pool/settings', async (_req, res) => {
  try {
    const settings = await query<{ daily_free_pool_limit: number }>('SELECT daily_free_pool_limit FROM system_settings ORDER BY updated_at DESC LIMIT 1');
    res.json({ daily_free_pool_limit: Number(settings.rows[0]?.daily_free_pool_limit || 200) });
  } catch (err: any) {
    res.status(500).json({ error: 'free_pool_settings_failed', details: err.message });
  }
});

app.post('/admin/free-pool/settings/update', async (req, res) => {
  try {
    const limit = Number((req.body?.daily_free_pool_limit || 0));
    if (!Number.isFinite(limit) || limit <= 0) return res.status(400).json({ error: 'invalid_limit' });
    await query('INSERT INTO system_settings(daily_free_pool_limit) VALUES ($1)', [limit]);
    res.json({ ok: true, daily_free_pool_limit: limit });
  } catch (err: any) {
    res.status(500).json({ error: 'free_pool_settings_update_failed', details: err.message });
  }
});
app.listen(config.apiPort, () => {
  console.log(`API listening on port ${config.apiPort}`);
});
app.get('/admin/keys', async (_req, res) => {
  try {
    const rows = await query('SELECT id, key, status, last_used_at, total_requests, total_success, total_failed, consecutive_errors FROM ninja_keys ORDER BY id');
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_keys_failed', details: err.message });
  }
});

app.post('/admin/keys/refresh', async (_req, res) => {
  try {
    const keys = (process.env.NINJA_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const k of keys) {
      await query(`INSERT INTO ninja_keys(key, status) VALUES ($1, 'active') ON CONFLICT (key) DO NOTHING`, [k]);
    }
    const rows = await query('SELECT id, key, status, last_used_at, total_requests, total_success, total_failed, consecutive_errors FROM ninja_keys ORDER BY id');
    res.json({ ok: true, keys: rows.rows });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_keys_refresh_failed', details: err.message });
  }
});

app.post('/admin/keys/recount', async (_req, res) => {
  try {
    const totals = await query<{ key: string; c: string }>(
      `SELECT ninja_key_used AS key, COUNT(*) AS c FROM validation_results WHERE ninja_key_used IS NOT NULL GROUP BY ninja_key_used`
    );
    for (const r of totals.rows) {
      await query('UPDATE ninja_keys SET total_requests=$2, total_success=$2 WHERE key=$1', [r.key, Number(r.c || 0)]);
    }
    res.json({ ok: true, updated: totals.rowCount });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_keys_recount_failed', details: err.message });
  }
});

app.post('/admin/keys/:id/activate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await query('UPDATE ninja_keys SET status=$2 WHERE id=$1', [id, 'active']);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_key_activate_failed', details: err.message });
  }
});

app.post('/admin/keys/:id/deactivate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await query('UPDATE ninja_keys SET status=$2 WHERE id=$1', [id, 'disabled']);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_key_deactivate_failed', details: err.message });
  }
});

app.get('/admin/workers', async (_req, res) => {
  try {
    const keys = await redis.keys('worker:*:status');
    const items = [] as any[];
    for (const k of keys) items.push(await redis.hgetall(k));
    res.json(items);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_workers_failed', details: err.message });
  }
});

app.get('/admin/system/stats', async (_req, res) => {
  try {
    const activeKeys = await query<{ c: string }>('SELECT COUNT(*) AS c FROM ninja_keys WHERE status=$1', ['active']);
    const totalWorkers = (await redis.keys('worker:*:status')).length;
    const activeBatchesQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM batches WHERE status IN ($1,$2)', ['created', 'running']);
    const todayValidationsQ = await query<{ c: string }>(`SELECT COUNT(*) AS c FROM validation_results WHERE validated_at::date = CURRENT_DATE`);
    const rtSum = Number(await redis.get('val_speed_sum') || '0');
    const rtCount = Number(await redis.get('val_speed_cnt') || '0');
    const speed = rtCount > 0 ? Math.round(rtCount / Math.max(1, (rtSum / 60000))) : 0;
    res.json({ active_keys: Number(activeKeys.rows[0]?.c || 0), total_workers: totalWorkers, active_batches: Number(activeBatchesQ.rows[0]?.c || 0), validation_speed_per_min: speed, today_validations: Number(todayValidationsQ.rows[0]?.c || 0) });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_system_stats_failed', details: err.message });
  }
});

app.get('/admin/system/speed', async (_req, res) => {
  try {
    const points = await redis.lrange('val_speed_points', 0, 2000);
    const now = Date.now();
    const buckets: Record<string, number> = {};
    for (const p of points) {
      const ts = Number(p);
      const diffMin = Math.floor((now - ts) / 60000);
      if (diffMin >= 0 && diffMin < 10) {
        const key = String(10 - diffMin);
        buckets[key] = (buckets[key] || 0) + 1;
      }
    }
    const series = Array.from({ length: 10 }).map((_, i) => {
      const label = `${i - 9}m`; // -9m .. 0m
      const key = String(10 - (9 - i));
      return { name: label, value: buckets[key] || 0 };
    });
    res.json(series);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_system_speed_failed', details: err.message });
  }
});

// Admin: queue stats (waiting, active, delayed, completed, failed)
app.get('/admin/queues/stats', async (_req, res) => {
  try {
    const list: { name: string; q: any }[] = [
      { name: QUEUE_NAMES.dedupe, q: dedupeQueue },
      { name: QUEUE_NAMES.filter, q: filterQueue },
      { name: QUEUE_NAMES.personal, q: personalQueue },
      { name: QUEUE_NAMES.validation, q: validationQueue },
      ...validationQueues.map((q, i) => ({ name: `${QUEUE_NAMES.validation}_${i}`, q }))
    ];
    const stats = [] as any[];
    for (const { name, q } of list) {
      try {
        const c = await q.getJobCounts('waiting','active','delayed','completed','failed');
        stats.push({ name, ...c });
      } catch (e: any) {
        stats.push({ name, error: e?.message || 'failed' });
      }
    }
    const validationAll = stats.filter(s => String(s.name).startsWith(`${QUEUE_NAMES.validation}_`));
    if (validationAll.length > 0) {
      const sum = (k: string) => validationAll.reduce((acc, s) => acc + Number((s as any)[k] || 0), 0);
      stats.unshift({ name: 'validation_all', waiting: sum('waiting'), active: sum('active'), delayed: sum('delayed'), completed: sum('completed'), failed: sum('failed') });
    }
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: 'admin_queues_stats_failed', details: err.message });
  }
});

// Enqueue pending validation jobs (useful when a new batch appears not validating yet)
app.post('/admin/validation/enqueue', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const batchId = Number((req.body?.batch_id || 0));
    const rows = await query<{ id: number }>(
      `SELECT me.id
       FROM master_emails me
       LEFT JOIN validation_results vr ON vr.master_id = me.id
       JOIN filtered_emails fe ON fe.master_id = me.id
       WHERE vr.master_id IS NULL
         AND fe.status NOT LIKE 'removed:%'
         ${batchId ? 'AND me.batch_id = $1' : ''}
       ORDER BY me.id
       LIMIT 2000`,
      batchId ? [batchId] : []
    );
    let enq = 0;
    for (const r of rows.rows) {
      try {
        const m = await query<{ batch_id: number }>('SELECT batch_id FROM master_emails WHERE id=$1', [r.id]);
        const bid = Number(m.rows[0]?.batch_id || 0);
        if (bid) {
          const va = await import('../utils/validationAssignment')
          await va.ensureBatchActivated(bid)
        }
        const idx = bid ? await (await import('../utils/validationAssignment')).assignWorkerRoundRobin(bid) : 0;
        const queuesMod = await import('../queues');
        const qArr = (queuesMod as any).validationQueues as any[];
        const q = qArr[idx] || qArr[0];
        await q.add('validateEmail', { masterId: r.id }, { jobId: String(r.id), removeOnComplete: true, removeOnFail: true });
        enq++;
      } catch {}
    }
    res.json({ enqueued: enq, batch_id: batchId || null });
  } catch (err: any) {
    res.status(500).json({ error: 'admin_validation_enqueue_failed', details: err.message });
  }
});
app.get('/admin/validation/pending', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT me.batch_id, COUNT(*) AS c
       FROM master_emails me
       LEFT JOIN validation_results vr ON vr.master_id = me.id
       JOIN filtered_emails fe ON fe.master_id = me.id
       WHERE vr.master_id IS NULL AND fe.status NOT LIKE 'removed:%'
       GROUP BY me.batch_id
       ORDER BY me.batch_id`
    );
    res.json(rows.rows.map((r: any) => ({ batch_id: r.batch_id, pending: Number(r.c || 0) })));
  } catch (err: any) {
    res.status(500).json({ error: 'admin_validation_pending_failed', details: err.message });
  }
});
app.delete('/batches/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { id: actorUuid } = getSupabaseUser(req);
    const b = await query<{ submitter_uuid: string | null }>('SELECT submitter_uuid FROM batches WHERE batch_id=$1', [id]);
    const owner = String(b.rows[0]?.submitter_uuid || '');
    if (!actorUuid || String(actorUuid) !== owner) return res.status(403).json({ error: 'forbidden' });

    // cancel queued jobs
    const masters = await query<{ id: number }>('SELECT id FROM master_emails WHERE batch_id=$1', [id]);
    const masterIds = new Set(masters.rows.map(r => r.id));
    const removeJobs = async (q: any, types: string[], match: (job: any) => boolean) => {
      const jobs = await q.getJobs(types);
      for (const j of jobs) { try { if (match(j)) await j.remove(); } catch {} }
    };
    await removeJobs(dedupeQueue, ['waiting','delayed'], (j) => j?.data?.batchId === id);
    await removeJobs(filterQueue, ['waiting','delayed'], (j) => masterIds.has(Number(j?.data?.masterId)));
    await removeJobs(personalQueue, ['waiting','delayed'], (j) => masterIds.has(Number(j?.data?.masterId)));
    await removeJobs(validationQueue, ['waiting','delayed'], (j) => masterIds.has(Number(j?.data?.masterId)));
    for (const vq of validationQueues) {
      await removeJobs(vq, ['waiting','delayed'], (j) => masterIds.has(Number(j?.data?.masterId)));
    }

    await query('UPDATE batches SET status=$2 WHERE batch_id=$1', [id, 'deleted']);

    await query('BEGIN');
    await query('DELETE FROM validation_results WHERE master_id IN (SELECT id FROM master_emails WHERE batch_id=$1)', [id]);
    await query('DELETE FROM filtered_emails WHERE batch_id=$1', [id]);
    await query('DELETE FROM filter_emails WHERE master_id IN (SELECT id FROM master_emails WHERE batch_id=$1)', [id]);
    await query('DELETE FROM personal_emails WHERE master_id IN (SELECT id FROM master_emails WHERE batch_id=$1)', [id]);
    await query('DELETE FROM final_business_emails WHERE batch_id=$1', [id]);
    await query('DELETE FROM final_personal_emails WHERE batch_id=$1', [id]);
    await query('DELETE FROM free_pool WHERE batch_id=$1', [id]);
    await query('DELETE FROM free_pool_assignments WHERE employee_uuid IN (SELECT DISTINCT assigned_to_uuid FROM free_pool WHERE batch_id=$1)', [id]);
    await query('DELETE FROM master_emails_temp WHERE batch_id=$1', [id]);
    await query('DELETE FROM master_emails WHERE batch_id=$1', [id]);
    await query('DELETE FROM batches WHERE batch_id=$1', [id]);
    await query('COMMIT');

    await publish(CHANNELS.batchProgress, { type: 'batch_deleted', batchId: id });
    try {
      const { releaseBatchAssignment } = await import('../utils/validationAssignment');
      await releaseBatchAssignment(id);
    } catch {}
    await query('INSERT INTO audit_logs(action_type, actor_id, resource_ref, details) VALUES ($1, $2, $3, $4)', ['batch_deleted', 0, String(id), JSON.stringify({ deleted_by: actorUuid })]);
    res.json({ success: true, message: 'Batch deleted', batch_id: id });
  } catch (err: any) {
    try { await query('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'batch_delete_failed', details: err.message });
  }
});
