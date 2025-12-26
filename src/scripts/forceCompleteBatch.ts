
import { query } from '../db';
import { redis, publish, CHANNELS } from '../redis';

async function forceComplete() {
  const batchId = process.argv[2];
  if (!batchId) {
    console.error('Usage: npx ts-node src/scripts/forceCompleteBatch.ts <BATCH_ID>');
    process.exit(1);
  }

  const id = Number(batchId);
  console.log(`Forcing completion for Batch ${id}...`);

  // 1. Update status in DB
  await query('UPDATE batches SET status=$2 WHERE batch_id=$1', [id, 'completed']);

  // 2. Clear any active locks in Redis
  const activeBatch = await redis.get('val:active_batch_id');
  if (activeBatch && Number(activeBatch) === id) {
    console.log('Releasing active batch lock...');
    await redis.del('val:active_batch_id');
  }

  // 3. Notify Frontend
  console.log('Publishing completion event...');
  await publish(CHANNELS.batchProgress, { 
    batchId: id, 
    step: 'done', 
    stage: 'completed',
    processed: 100, 
    total: 100 
  });

  console.log(`Batch ${id} marked as COMPLETED.`);
  process.exit(0);
}

forceComplete().catch(console.error);
