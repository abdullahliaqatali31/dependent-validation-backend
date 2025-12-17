import { query } from '../db';
import { filterQueue, validationQueues } from '../queues';
import { ensureBatchActivated, assignWorkerRoundRobin, releaseBatchAssignment } from '../utils/validationAssignment';
import { publish, CHANNELS } from '../redis';

async function main() {
  const arg = process.argv[2];
  const batchId = Number(arg || process.env.BATCH_ID || 0);
  if (!Number.isFinite(batchId) || batchId <= 0) {
    console.log('Usage: npm run unstick:batch -- <batchId>  (or set BATCH_ID)');
    process.exit(1);
  }

  const b = await query<{ status: string; paused_stage: string | null }>('SELECT status, paused_stage FROM batches WHERE batch_id=$1', [batchId]);
  if (b.rows.length === 0) {
    console.log(`Batch ${batchId} not found. Nothing to do.`);
    process.exit(0);
  }

  const status = String(b.rows[0]?.status || '').toLowerCase();
  const pausedStage = String(b.rows[0]?.paused_stage || '').toLowerCase();
  console.log(`Batch ${batchId} current status="${status}" paused_stage="${pausedStage || ''}"`);

  // Clear any per-batch assignment locks
  try {
    await releaseBatchAssignment(batchId);
    console.log('Released batch assignment locks.');
  } catch (e) {
    console.log('Release assignment failed (continuing):', (e as any)?.message || e);
  }

  // 1) Re-enqueue filter jobs for any master rows not yet filtered
  const filterPending = await query<{ id: number }>(
    `SELECT me.id
     FROM master_emails me
     WHERE me.batch_id=$1
       AND NOT EXISTS (SELECT 1 FROM filtered_emails fe WHERE fe.master_id=me.id)
     ORDER BY me.id
     LIMIT 50000`,
    [batchId]
  );
  let filterEnq = 0;
  for (const r of filterPending.rows) {
    await filterQueue.add('filterEmail', { masterId: r.id }, { removeOnComplete: true, removeOnFail: true });
    filterEnq++;
  }
  console.log(`Re-enqueued ${filterEnq} filter jobs.`);

  // 2) Re-enqueue validation jobs for filtered emails not yet validated
  const valPending = await query<{ id: number }>(
    `SELECT me.id
     FROM master_emails me
     JOIN filtered_emails fe ON fe.master_id=me.id
     WHERE me.batch_id=$1
       AND fe.status NOT LIKE 'removed:%'
       AND NOT EXISTS (SELECT 1 FROM validation_results vr WHERE vr.master_id=me.id)
     ORDER BY me.id
     LIMIT 50000`,
    [batchId]
  );
  let valEnq = 0;
  if (valPending.rows.length > 0) {
    await ensureBatchActivated(batchId);
    for (const r of valPending.rows) {
      const idx = await assignWorkerRoundRobin(batchId);
      const q = validationQueues[idx] || validationQueues[0];
      await q.add('validateEmail', { masterId: r.id }, { removeOnComplete: false, removeOnFail: false });
      valEnq++;
    }
  }
  console.log(`Re-enqueued ${valEnq} validation jobs.`);

  await publish(CHANNELS.batchProgress, { batchId, stage: 'unstick', filter_requeued: filterEnq, validation_requeued: valEnq });
  console.log('Unstick complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('Unstick failed:', err);
  process.exit(1);
});
