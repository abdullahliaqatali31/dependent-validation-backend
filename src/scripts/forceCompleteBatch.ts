
import { query } from '../db';
import { releaseBatchAssignment } from '../utils/validationAssignment';
import { redis } from '../redis';

async function main() {
  const batchId = process.argv[2] ? Number(process.argv[2]) : null;

  if (!batchId) {
    console.error('Usage: ts-node forceCompleteBatch.ts <batchId>');
    process.exit(1);
  }

  console.log(`[ForceComplete] Forcing completion for batch ${batchId}...`);

  try {
    // 1. Update DB status
    console.log('[ForceComplete] Updating DB status to "completed"...');
    await query('UPDATE batches SET status=$1, updated_at=NOW() WHERE batch_id=$2', ['completed', batchId]);
    
    // 2. Release Redis locks
    console.log('[ForceComplete] Releasing Redis locks...');
    await releaseBatchAssignment(batchId);

    // 3. Verify
    const res = await query('SELECT status FROM batches WHERE batch_id=$1', [batchId]);
    const active = await redis.get('val:active_batch_id');

    console.log('-----------------------------------');
    console.log(`Batch ${batchId} status: ${res.rows[0]?.status}`);
    console.log(`Active Validation Batch (Redis): ${active}`);
    console.log('-----------------------------------');

    if (active && Number(active) === batchId) {
        console.warn('WARNING: Redis lock still exists!');
    } else {
        console.log('SUCCESS: Batch completed and locks released.');
    }

  } catch (e) {
    console.error('[ForceComplete] Error:', e);
  } finally {
    process.exit(0);
  }
}

main();
