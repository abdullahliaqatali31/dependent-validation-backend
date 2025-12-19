
import { query } from '../db';
import { dedupeQueue, filterQueue, validationQueues, personalQueue } from '../queues';
import { ensureBatchActivated, assignWorkerRoundRobin } from '../utils/validationAssignment';
import { redis } from '../redis';

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function logWatcherActivity(details: any) {
    const ts = new Date().toISOString();
    const entry = JSON.stringify({ ts, ...details });
    await redis.set('queue_watcher:last_run', ts);
    await redis.lpush('queue_watcher:history', entry);
    await redis.ltrim('queue_watcher:history', 0, 49); // Keep last 50 entries
}

async function checkAndResume() {
  console.log('[QueueWatcher] Checking for stuck batches...');
  const activity: any = { stuck_dedupe: 0, stuck_filter: 0, stuck_validation: 0, stuck_split: 0, batches_affected: [] };
  const affectedBatches = new Set<number>();

  try {
    // 1. Stuck Dedupe (Batches with data in temp but not processing)
    const stuckDedupe = await query<{ batch_id: number }>(
      `SELECT DISTINCT batch_id FROM master_emails_temp`
    );
    
    for (const row of stuckDedupe.rows) {
      const batchId = Number(row.batch_id);
      affectedBatches.add(batchId);
      try {
        await dedupeQueue.add('dedupeBatch', { batchId }, { 
            jobId: `dedupe-resume-${batchId}-${Date.now()}`, 
            removeOnComplete: true,
            removeOnFail: true
        });
        console.log(`[QueueWatcher] Enqueued dedupe for batch ${batchId}`);
        activity.stuck_dedupe++;
      } catch (e) {
        console.error(`[QueueWatcher] Failed to enqueue dedupe for batch ${batchId}`, e);
      }
    }

    // 2. Stuck Filter (Master emails without filtered emails)
    const stuckFilter = await query<{ batch_id: number }>(
      `SELECT DISTINCT me.batch_id 
       FROM master_emails me 
       LEFT JOIN filtered_emails fe ON fe.master_id = me.id 
       WHERE fe.id IS NULL 
       LIMIT 50` 
    );

    for (const row of stuckFilter.rows) {
        const batchId = Number(row.batch_id);
        const missing = await query<{ id: number }>(
            `SELECT me.id FROM master_emails me 
             LEFT JOIN filtered_emails fe ON fe.master_id = me.id 
             WHERE me.batch_id = $1 AND fe.id IS NULL
             LIMIT 1000`, 
            [batchId]
        );
        
        if (missing.rows.length > 0) {
            affectedBatches.add(batchId);
            console.log(`[QueueWatcher] Found ${missing.rows.length} pending filter jobs for batch ${batchId}`);
            activity.stuck_filter += missing.rows.length;
            for (const m of missing.rows) {
                await filterQueue.add('filterEmail', { masterId: m.id }, {
                    jobId: `filter-${m.id}`, 
                    removeOnComplete: true,
                    removeOnFail: true
                });
            }
        }
    }

    // 4. Stuck Validation (Filtered emails (not removed) that are NOT validated)
    const stuckValidation = await query<{ batch_id: number }>(
        `SELECT DISTINCT me.batch_id
         FROM master_emails me
         JOIN filtered_emails fe ON fe.master_id = me.id
         LEFT JOIN validation_results vr ON vr.master_id = me.id
         WHERE fe.status NOT LIKE 'removed:%'
           AND vr.master_id IS NULL
         LIMIT 50`
    );

    for (const row of stuckValidation.rows) {
        const batchId = Number(row.batch_id);
        
        // Check if batch is paused
        const b = await query<{ status: string; paused_stage: string | null }>('SELECT status, paused_stage FROM batches WHERE batch_id=$1', [batchId]);
        const paused = String(b.rows[0]?.status || '').toLowerCase() === 'paused';
        const pausedStage = String(b.rows[0]?.paused_stage || '').toLowerCase();
        
        if (paused && pausedStage === 'validation') {
            console.log(`[QueueWatcher] Batch ${batchId} is paused for validation. Skipping.`);
            continue;
        }

        // Prevent hanging: Check if another batch is currently active
        const activeBatchId = await redis.get('val:active_batch_id');
        if (activeBatchId && Number(activeBatchId) !== batchId) {
            console.log(`[QueueWatcher] Another batch (${activeBatchId}) is active. Skipping validation check for batch ${batchId} to prevent blocking.`);
            continue;
        }

        await ensureBatchActivated(batchId);

        const missing = await query<{ id: number }>(
            `SELECT me.id
             FROM master_emails me
             JOIN filtered_emails fe ON fe.master_id = me.id
             LEFT JOIN validation_results vr ON vr.master_id = me.id
             WHERE me.batch_id = $1
               AND fe.status NOT LIKE 'removed:%'
               AND vr.master_id IS NULL
             LIMIT 1000`, // Chunk size
            [batchId]
        );

        if (missing.rows.length > 0) {
            affectedBatches.add(batchId);
            console.log(`[QueueWatcher] Found ${missing.rows.length} pending validation jobs for batch ${batchId}`);
            activity.stuck_validation += missing.rows.length;
            for (const m of missing.rows) {
                const idx = await assignWorkerRoundRobin(batchId);
                const q = validationQueues[idx] || validationQueues[0];
                await q.add('validateEmail', { masterId: m.id }, {
                    jobId: `val-${m.id}`, 
                    removeOnComplete: false, 
                    removeOnFail: false
                });
            }
        }
    }

    // 5. Stuck Split (Validated but not in final tables)
    const stuckSplit = await query<{ batch_id: number }>(
        `SELECT DISTINCT me.batch_id
         FROM validation_results vr
         JOIN master_emails me ON vr.master_id = me.id
         LEFT JOIN final_personal_emails fpe ON fpe.master_id = me.id
         LEFT JOIN final_business_emails fbe ON fbe.master_id = me.id
         WHERE fpe.id IS NULL AND fbe.id IS NULL
         LIMIT 50`
    );

    for (const row of stuckSplit.rows) {
        const batchId = Number(row.batch_id);
        const missing = await query<{ id: number }>(
            `SELECT vr.master_id AS id
             FROM validation_results vr
             JOIN master_emails me ON vr.master_id = me.id
             LEFT JOIN final_personal_emails fpe ON fpe.master_id = me.id
             LEFT JOIN final_business_emails fbe ON fbe.master_id = me.id
             WHERE me.batch_id = $1
               AND fpe.id IS NULL AND fbe.id IS NULL
             LIMIT 1000`,
            [batchId]
        );

        if (missing.rows.length > 0) {
            affectedBatches.add(batchId);
            console.log(`[QueueWatcher] Found ${missing.rows.length} pending split jobs for batch ${batchId}`);
            activity.stuck_split += missing.rows.length;
            for (const m of missing.rows) {
                 await personalQueue.add('personalCheck', { masterId: m.id }, {
                    jobId: `split-${m.id}`,
                    removeOnComplete: true,
                    removeOnFail: true
                });
            }
        }
    }
    
    activity.batches_affected = Array.from(affectedBatches);
    await logWatcherActivity(activity);

  } catch (e) {
    console.error('[QueueWatcher] Error during check:', e);
    await logWatcherActivity({ error: (e as any)?.message || String(e) });
  }
}

// Start the loop
(async () => {
  console.log('[QueueWatcher] Started. Running every 1 minute.');
  while (true) {
    await checkAndResume();
    await sleep(CHECK_INTERVAL_MS);
  }
})();
