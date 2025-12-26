import { Worker, Job } from 'bullmq';
import { defaultWorkerOptions } from './common';
import { config } from '../config';
import { query } from '../db';
import { bloomAdd, bloomExists, publish, CHANNELS } from '../redis';
import { normalizeEmail } from '../utils/normalizeEmail';
import { filterQueue } from '../queues';

const CHUNK_SIZE = 1000;

async function processBatch(batchId: number) {
  // Load submitter identity once from the batch
  const b = await query<{ submitter_id: number | null; submitter_uuid: string | null; submitter_team_id: number | null; total_count: number }>(
    'SELECT submitter_id, submitter_uuid, submitter_team_id, total_count FROM batches WHERE batch_id=$1',
    [batchId]
  );
  if (b.rows.length === 0) {
    return;
  }
  const pausedStageQ = await query<{ status: string; paused_stage: string | null }>('SELECT status, paused_stage FROM batches WHERE batch_id=$1', [batchId]);
  const paused = String(pausedStageQ.rows[0]?.status || '').toLowerCase() === 'paused';
  const pausedStage = String(pausedStageQ.rows[0]?.paused_stage || '').toLowerCase();
  if (paused && pausedStage === 'dedupe') {
    await publish(CHANNELS.batchProgress, { batchId, stage: 'dedupe', status: 'paused' });
    return;
  }
  const submitter_id = (b.rows[0]?.submitter_id ?? null) as number | null;
  const submitter_uuid = (b.rows[0]?.submitter_uuid ?? null) as string | null;
  const submitter_team_id = (b.rows[0]?.submitter_team_id ?? null) as number | null;
  const batchTotal = Number(b.rows[0]?.total_count || 0);
  const totalQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM master_emails_temp WHERE batch_id=$1', [batchId]);
  const total = Number(totalQ.rows[0]?.c || 0);

  while (true) {
    const staged = await query<{ id: number; email_raw: string }>(
      'SELECT id, email_raw FROM master_emails_temp WHERE batch_id=$1 ORDER BY id LIMIT $2',
      [batchId, CHUNK_SIZE]
    );
    if (staged.rows.length === 0) break;

    for (const row of staged.rows) {
      const n = normalizeEmail(row.email_raw, 'none');
      let insertedId: number | null = null;
      const ins = await query<{ id: number }>(
        'INSERT INTO master_emails(email_normalized, email_raw, domain, local_part, batch_id, dedupe_status, submitter_id, submitter_team_id, submitter_uuid) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (email_normalized) DO NOTHING RETURNING id',
        [n.normalized, row.email_raw, n.domain, n.local, batchId, 'unique', submitter_id, submitter_team_id, submitter_uuid]
      );
      if (ins.rows.length > 0) {
        insertedId = ins.rows[0].id;
        await bloomAdd(config.bloomKey, n.normalized);
      }

      if (insertedId) {
        await filterQueue.add('filterEmail', { masterId: insertedId }, { removeOnComplete: true, removeOnFail: true });
      }
    }

    // Remove processed chunk from staging to keep idempotency clean
    const maxId = staged.rows[staged.rows.length - 1].id;
    await query('DELETE FROM master_emails_temp WHERE batch_id=$1 AND id<= $2', [batchId, maxId]);

    const stagedCountQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM master_emails_temp WHERE batch_id=$1', [batchId]);
    const masterCountQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM master_emails WHERE batch_id=$1', [batchId]);
    const stagedCount = Number(stagedCountQ.rows[0]?.c || 0);
    const masterCount = Number(masterCountQ.rows[0]?.c || 0);
    await publish(CHANNELS.batchProgress, { batchId, step: 'dedupe', stage: 'dedupe', processed: masterCount, total: stagedCount + masterCount });
  }
  const masterCountQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM master_emails WHERE batch_id=$1', [batchId]);
  const masterCount = Number(masterCountQ.rows[0]?.c || 0);

  // If we had input emails but resulted in 0 unique emails, mark batch as duplicate
  if (masterCount === 0 && batchTotal > 0) {
      await query('UPDATE batches SET status=$1, completed_at=NOW() WHERE batch_id=$2', ['duplicate', batchId]);
      await publish(CHANNELS.batchProgress, { batchId, step: 'dedupe', stage: 'Duplicate', processed: batchTotal, total: batchTotal });
      console.log(`[DedupeWorker] Batch ${batchId} marked as duplicate (all emails were duplicates)`);
      return;
  }

  await publish(CHANNELS.batchProgress, { batchId, step: 'dedupe', stage: 'dedupe_complete', processed: masterCount, total: masterCount });
}

export const dedupeWorker = new Worker(
  'dedupeQueue',
  async (job: Job) => {
    console.log(`[DedupeWorker] Processing job ${job.id} for batch ${job.data.batchId}`);
    const { batchId } = job.data as { batchId: number };
    try {
        await processBatch(batchId);
        console.log(`[DedupeWorker] Completed job ${job.id}`);
    } catch (e) {
        console.error(`[DedupeWorker] Failed job ${job.id}:`, e);
        throw e;
    }
  },
  defaultWorkerOptions(config.redisUrl)
);

console.log('dedupeWorker started');
