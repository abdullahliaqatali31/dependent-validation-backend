import { redis } from '../redis';
import { query } from '../db';
import { config } from '../config';

async function main() {
  console.log('--- Checking Validation System State ---');

  // 1. Check Active Batch Lock
  const activeBatchId = await redis.get('val:active_batch_id');
  console.log(`Redis Key 'val:active_batch_id': ${activeBatchId ? activeBatchId : '(empty)'}`);

  if (activeBatchId) {
    const bId = Number(activeBatchId);
    
    // Check for "NaN", "null", or invalid numbers
    if (Number.isNaN(bId) || activeBatchId === 'NaN' || activeBatchId === 'null') {
        console.log(`[CRITICAL] active_batch_id is invalid ("${activeBatchId}"). Clearing it to unblock system.`);
        await redis.del('val:active_batch_id');
        console.log('Lock deleted.');
    } else {
        // Check if this batch exists in DB
        const res = await query('SELECT status FROM batches WHERE batch_id=$1', [bId]);
        if (res.rows.length === 0) {
            console.log(`[CRITICAL] Batch ${bId} is ACTIVE in Redis but DELETED from DB.`);
            console.log('Action: Deleting stale lock...');
            await redis.del('val:active_batch_id');
            console.log('Lock deleted.');
        } else {
            console.log(`Batch ${bId} exists in DB with status: ${res.rows[0].status}`);
        }
    }
  }

  // 2. Check Worker Assignments
  const keys = config.ninjaKeys;
  console.log(`\nChecking ${keys.length} worker slots...`);
  
  for (let i = 0; i < keys.length; i++) {
    const workerBatch = await redis.get(`val:worker:${i}:batch_id`);
    const workerTs = await redis.get(`val:worker:${i}:batch_ts`);
    const heartbeat = await redis.hget(`worker:val-${i}:status`, 'lastHeartbeat');
    
    let info = `Worker ${i}: `;
    if (workerBatch) info += `Assigned Batch ${workerBatch} `;
    else info += `Idle `;
    
    if (heartbeat) {
        const diff = Date.now() - Number(heartbeat);
        info += `(Last heartbeat: ${Math.round(diff/1000)}s ago)`;
    } else {
        info += `(No heartbeat found)`;
    }
    console.log(info);

    // Auto-cleanup for deleted batches in workers
    if (workerBatch) {
        const wbId = Number(workerBatch);
        const res = await query('SELECT 1 FROM batches WHERE batch_id=$1', [wbId]);
        if (res.rows.length === 0) {
             console.log(`  -> Worker ${i} is assigned to DELETED batch ${wbId}. Clearing...`);
             await redis.del(`val:worker:${i}:batch_id`);
             await redis.del(`val:worker:${i}:batch_ts`);
        }
    }
  }

  console.log('\n--- Done ---');
  process.exit(0);
}

main().catch(console.error);
