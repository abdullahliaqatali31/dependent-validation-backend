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
  const b = await query<{ submitter_id: number | null; submitter_uuid: string | null; submitter_team_id: number | null }>(
    'SELECT submitter_id, submitter_uuid, submitter_team_id FROM batches WHERE batch_id=$1',
    [batchId]
  );
  const submitter_id = (b.rows[0]?.submitter_id ?? null) as number | null;
  const submitter_uuid = (b.rows[0]?.submitter_uuid ?? null) as string | null;
  const submitter_team_id = (b.rows[0]?.submitter_team_id ?? null) as number | null;
  const totalQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM master_emails_temp WHERE batch_id=$1', [batchId]);
  const total = Number(totalQ.rows[0]?.c || 0);
  let processedCount = 0;

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

    processedCount += staged.rows.length;
    await publish(CHANNELS.batchProgress, { batchId, step: 'dedupe', stage: 'dedupe', processed: processedCount, total });
  }
  await publish(CHANNELS.batchProgress, { batchId, step: 'dedupe', stage: 'dedupe_complete', processed: total, total });
}

export const dedupeWorker = new Worker(
  'dedupeQueue',
  async (job: Job) => {
    const { batchId } = job.data as { batchId: number };
    await processBatch(batchId);
  },
  defaultWorkerOptions(config.redisUrl)
);

console.log('dedupeWorker started');
