import { filterQueue } from '../queues';
import { query } from '../db';
import { redis } from '../redis';

async function main() {
  console.log('Connecting to queue...');
  
  // Pause queue to prevent processing while we clean
  await filterQueue.pause();
  console.log('Queue paused.');

  try {
    const counts = await filterQueue.getJobCounts();
    console.log('Current job counts:', counts);

    if (counts.waiting === 0 && counts.delayed === 0 && counts.paused === 0) {
      console.log('No waiting, paused, or delayed jobs found.');
      return;
    }

    // Process in chunks to avoid memory issues
    const CHUNK_SIZE = 1000;
    let processed = 0;
    let removed = 0;

    // We keep fetching from the head until we've checked everything
    // Note: getJobs returns jobs from start to end indices.
    // Since we are removing jobs, indices shift. It's safer to fetch a batch, 
    // decide what to remove, remove them, and then fetch again.
    // However, getJobs order might be stable.
    
    // Better strategy: Get all jobs (references), then process. 
    // If 40k is too many for memory, we might need a stream or careful pagination.
    // 40k objects isn't that huge for Node.js (approx few MBs).
    
    console.log('Fetching waiting/paused jobs...');
    // Only fetch paused, waiting, delayed. Skip active to avoid lock issues for now.
    const jobs = await filterQueue.getJobs(['waiting', 'delayed', 'paused'], 0, -1);
    console.log(`Fetched ${jobs.length} jobs.`);

    for (let i = 0; i < jobs.length; i += CHUNK_SIZE) {
      const chunk = jobs.slice(i, i + CHUNK_SIZE);
      const masterIds = chunk.map(j => j.data.masterId).filter(Boolean);
      
      if (masterIds.length === 0) continue;

      // Check which masterIds exist in DB
      const res = await query<{ id: number }>(
        'SELECT id FROM master_emails WHERE id = ANY($1::int[])',
        [masterIds]
      );
      const foundIds = new Set(res.rows.map(r => r.id));

      const toRemove = chunk.filter(j => !foundIds.has(j.data.masterId));
      
      console.log(`Chunk ${i/CHUNK_SIZE + 1}: Checking ${chunk.length} jobs. Found ${res.rowCount} valid in DB. Removing ${toRemove.length} zombies.`);

      // Remove zombies in parallel, with individual error handling
      await Promise.all(toRemove.map(async (j) => {
        try {
            await j.remove();
        } catch (e) {
            console.error(`Failed to remove job ${j.id}:`, e);
        }
      }));
      removed += toRemove.length;
      processed += chunk.length;
    }

    console.log(`\nCleanup complete.`);
    console.log(`Total processed: ${processed}`);
    console.log(`Total removed: ${removed}`);

  } catch (err) {
    console.error('Error during cleanup:', err);
  } finally {
    await filterQueue.resume();
    console.log('Queue resumed.');
    process.exit(0);
  }
}

main().catch(console.error);
