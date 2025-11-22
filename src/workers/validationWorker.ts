import { Worker, Job } from 'bullmq';
import { defaultWorkerOptions } from './common';
import { config } from '../config';
import { query } from '../db';
import { publish, CHANNELS } from '../redis';
import { QUEUE_NAMES, personalQueue } from '../queues';


function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function verifyWithNinja(email: string, key: string) {
  const url = `https://happy.mailtester.ninja/ninja?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}`;
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      // throttle per request under plan limits
      await sleep(config.ninjaDelayMs);
      const resp = await fetch(url, { method: 'GET' });
      if (resp.status === 429) {
        await sleep(1000);
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`http_${resp.status}:${text?.slice(0, 200)}`);
      }
      const data = await resp.json();
      const code = String((data.code || '').toString()).toLowerCase();
      const message = String((data.message || '').toString());
      let status: 'valid' | 'invalid' | 'unknown' | 'catch_all' = 'unknown';
      if (code === 'ok') status = 'valid';
      else if (code === 'ko' || code === 'invalid' || code === 'bad') status = 'invalid';
      else if (code === 'mb') {
        const m = message.toLowerCase();
        if (m.includes('catch')) status = 'catch_all';
        else if (m.includes('mx')) status = 'invalid';
      }
      return {
        status,
        detail: data,
        domain: data.domain || null,
        mx: data.mx || null,
        message
      } as any;
    } catch (e: any) {
      if (attempts < 3) {
        await sleep(1000);
        continue;
      }
      return { status: 'unknown', detail: { error: e?.message || 'network_error' } } as any;
    }
  }
  return { status: 'unknown', detail: { error: 'max_retries' } } as any;
}

function mapNinjaOutcome(message: string, code?: string): 'accepted' | 'catch_all' | 'rejected' | 'timeout' {
  const msg = String(message || '').toLowerCase();
  const c = String(code || '').toLowerCase();
  if (msg.includes('accepted') || c === 'ok') return 'accepted';
  if (msg.includes('catch') || msg.includes('limited')) return 'catch_all';
  if (msg.includes('rejected') || msg.includes('spam') || msg.includes('no mx') || msg.includes('mx error') || c === 'invalid' || c === 'bad' || c === 'ko') return 'rejected';
  if (msg.includes('timeout')) return 'timeout';
  return 'rejected';
}

async function validateMaster(masterId: number) {
  const m = await query<{ email_normalized: string; batch_id: number }>(
    'SELECT email_normalized, batch_id FROM master_emails WHERE id=$1',
    [masterId]
  );
  if (m.rows.length === 0) return;
  const email = m.rows[0].email_normalized;
  const batchId = m.rows[0].batch_id;
  const b = await query<{ status: string; paused_stage: string | null }>('SELECT status, paused_stage FROM batches WHERE batch_id=$1', [batchId]);
  const paused = String(b.rows[0]?.status || '').toLowerCase() === 'paused';
  const pausedStage = String(b.rows[0]?.paused_stage || '').toLowerCase();
  if (paused && pausedStage === 'validation') {
    await publish(CHANNELS.batchProgress, { batchId, stage: 'validation', status: 'paused', master_id: masterId });
    return;
  }
  if (!Array.isArray(config.ninjaKeys) || config.ninjaKeys.length === 0) {
    const domainQ = await query<{ domain: string | null }>('SELECT domain FROM master_emails WHERE id=$1', [masterId]);
    const domain = domainQ.rows[0]?.domain || null;
    const isPersonalQ = await query<{ count: string }>('SELECT COUNT(*) FROM public_provider_domains WHERE domain=$1', [domain || '']);
    const isPersonal = Number(isPersonalQ.rows[0]?.count || 0) > 0;
    const category = isPersonal ? 'personal' : 'business';
    await query(
      `INSERT INTO validation_results(master_id, status_enum, details, ninja_key_used, domain, mx, message, metadata, category, outcome, is_personal, is_business)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [masterId, 'unknown', JSON.stringify({ error: 'no_keys_configured' }), null, domain, null, 'no_keys_configured', JSON.stringify({ domain }), category, 'timeout', isPersonal, !isPersonal]
    );
    try {
      const totalQ = await query<{ count: string }>('SELECT COUNT(*) FROM master_emails WHERE batch_id=$1', [batchId]);
      const doneQ = await query<{ count: string }>('SELECT COUNT(*) FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1', [batchId]);
      const total = Number(totalQ.rows[0]?.count || 0);
      const done = Number(doneQ.rows[0]?.count || 0);
      await publish(CHANNELS.batchProgress, { batchId, step: 'validation', stage: 'validation', processed: done, total });
      await personalQueue.add('personalCheck', { masterId }, { removeOnComplete: true, removeOnFail: true });
    } catch {}
    return;
  }
  const key = (config.ninjaKeys && config.ninjaKeys.length > 0) ? config.ninjaKeys[0] : '';
  try {
    const resp = await verifyWithNinja(email, key);
    const domain = (resp as any).domain || null;
    const mx = (resp as any).mx || null;
    const message = (resp as any).message || null;
    const details = resp.detail || {};
    if (message && typeof details === 'object') (details as any).reason = (details as any).reason || message;
    const outcome = mapNinjaOutcome(message || '', (resp as any)?.detail?.code);
    const isPersonalQ = await query<{ count: string }>('SELECT COUNT(*) FROM public_provider_domains WHERE domain=$1', [domain || '']);
    const isPersonal = Number(isPersonalQ.rows[0]?.count || 0) > 0;
    const category = isPersonal ? 'personal' : 'business';
    await query(
      `INSERT INTO validation_results(master_id, status_enum, details, ninja_key_used, domain, mx, message, metadata, category, outcome, is_personal, is_business)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [masterId, resp.status, JSON.stringify(details), key, domain, mx, message, JSON.stringify({ domain, mx, code: (resp as any)?.detail?.code }), category, outcome, isPersonal, !isPersonal]
    );
    // Publish progress for validation stage (simple per-email update)
    try {
      const totalQ = await query<{ count: string }>('SELECT COUNT(*) FROM master_emails WHERE batch_id=$1', [batchId]);
      const doneQ = await query<{ count: string }>('SELECT COUNT(*) FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1', [batchId]);
      const total = Number(totalQ.rows[0]?.count || 0);
      const done = Number(doneQ.rows[0]?.count || 0);
      await publish(CHANNELS.batchProgress, { batchId, step: 'validation', stage: 'validation', processed: done, total });
      if (total > 0 && done >= total) {
        await query('UPDATE batches SET status=$2 WHERE batch_id=$1', [batchId, 'completed']);
        await publish(CHANNELS.batchProgress, { batchId, step: 'done', stage: 'completed', processed: done, total });
      }
      await personalQueue.add('personalCheck', { masterId }, { removeOnComplete: true, removeOnFail: true });
    } catch {}
  } catch (e) {
    try {
      await query('INSERT INTO audit_logs(action_type, details, resource_ref) VALUES ($1, $2, $3)', [
        'validation_error',
        JSON.stringify({ email, error: (e as any)?.message || String(e) }),
        String(masterId)
      ]);
    } catch {}
    // Simple backoff on rate limit
    if ((e as any)?.message && String((e as any).message).includes('http_429')) await sleep(config.ninjaDelayMs * 2);
    throw e;
  } finally {
    // single key mode does not require release
  }
}

export const validationWorker = new Worker(
  QUEUE_NAMES.validation,
  async (job: Job) => {
    const { masterId } = job.data as { masterId: number };
    await validateMaster(masterId);
  },
  { ...defaultWorkerOptions(config.redisUrl), concurrency: 1 }
);

console.log('validationWorker started');
