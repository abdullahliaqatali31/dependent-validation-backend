import { Worker, Job } from 'bullmq';
import { defaultWorkerOptions, DEFAULT_PUBLIC_DOMAINS } from './common';
import { config } from '../config';
import { query } from '../db';
import { validationQueue } from '../queues';
import { publish, CHANNELS } from '../redis';

async function isPublicDomain(domain: string): Promise<boolean> {
  if (DEFAULT_PUBLIC_DOMAINS.has(domain.toLowerCase())) return true;
  const r = await query('SELECT 1 FROM public_provider_domains WHERE domain=$1', [domain]);
  return r.rows.length > 0;
}

async function processMaster(masterId: number) {
  const m = await query<{ email_normalized: string; domain: string; batch_id: number }>('SELECT email_normalized, domain, batch_id FROM master_emails WHERE id=$1', [masterId]);
  if (m.rows.length === 0) return;
  const { domain, batch_id } = m.rows[0];
  const b = await query<{ status: string; paused_stage: string | null }>('SELECT status, paused_stage FROM batches WHERE batch_id=$1', [batch_id]);
  const paused = String(b.rows[0]?.status || '').toLowerCase() === 'paused';
  const pausedStage = String(b.rows[0]?.paused_stage || '').toLowerCase();
  if (paused && pausedStage === 'personal') {
    await publish(CHANNELS.batchProgress, { batchId: batch_id, stage: 'personal', status: 'paused', master_id: masterId });
    return;
  }
  const vr = await query<{ outcome: string | null; category: string | null }>('SELECT outcome, category FROM validation_results WHERE master_id=$1 ORDER BY validated_at DESC LIMIT 1', [masterId]);
  if (vr.rows.length === 0) return;
  const outcome = String(vr.rows[0].outcome || '').toLowerCase();
  let category = String(vr.rows[0].category || '').toLowerCase();

  const isPublic = await isPublicDomain(domain);
  if (isPublic) {
    category = 'personal';
  }

  const submitterQ = await query<{ submitter_uuid: string | null }>('SELECT submitter_uuid FROM batches WHERE batch_id=$1', [batch_id]);
  const submitterUuid = submitterQ.rows[0]?.submitter_uuid || null;
  const roleQ = submitterUuid ? await query<{ role: string | null }>('SELECT role FROM profiles WHERE id=$1', [submitterUuid]) : { rows: [] } as any;
  const isCollector = String(roleQ.rows[0]?.role || '').toLowerCase() === 'collector';
  const emailQ = await query<{ email_normalized: string }>('SELECT email_normalized FROM master_emails WHERE id=$1', [masterId]);
  const email = emailQ.rows[0]?.email_normalized || '';
  if (category === 'personal') {
    await query('INSERT INTO final_personal_emails(batch_id, master_id, email, domain, outcome, is_free_pool) SELECT $1, me.id, me.email_normalized, me.domain, $2, $4 FROM master_emails me WHERE me.id=$3', [batch_id, outcome, masterId, isCollector]);
  } else {
    await query('INSERT INTO final_business_emails(batch_id, master_id, email, domain, outcome, is_free_pool) SELECT $1, me.id, me.email_normalized, me.domain, $2, $4 FROM master_emails me WHERE me.id=$3', [batch_id, outcome, masterId, isCollector]);
  }
  if (isCollector) {
    await query(
      'INSERT INTO free_pool(email, domain, category, outcome, metadata, is_assigned, is_free_pool, batch_id) VALUES ($1, $2, $3, $4, $5, false, true, $6)',
      [email, domain, category, outcome, JSON.stringify({ master_id: masterId }), batch_id]
    );
  }
  try {
    const totalValidatedQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1', [batch_id]);
    const totalSplittedQ = await query<{ c: string }>('SELECT (SELECT COUNT(*) FROM final_business_emails WHERE batch_id=$1) + (SELECT COUNT(*) FROM final_personal_emails WHERE batch_id=$1) AS c', [batch_id]);
    const processed = Number(totalSplittedQ.rows[0]?.c || 0);
    const total = Number(totalValidatedQ.rows[0]?.c || 0);
    await publish(CHANNELS.batchProgress, { batchId: batch_id, step: 'split', stage: 'split', processed, total });
  } catch {}
}

export const personalWorker = new Worker(
  'personalQueue',
  async (job: Job) => {
    const { masterId } = job.data as { masterId: number };
    await processMaster(masterId);
  },
  defaultWorkerOptions(config.redisUrl)
);

console.log('personalWorker started');
