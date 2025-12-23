
import { validationQueues } from '../queues';
import { redis } from '../redis';

async function clean() {
  console.log('Starting cleanup of duplicate validation jobs...');
  
  // Map<MasterID, List of Job Entries>
  const map = new Map<number, { queueIdx: number, job: any, state: string, id: string }[]>();
  let totalFound = 0;

  // 1. Gather all jobs from all queues
  console.log(`Scanning ${validationQueues.length} validation queues...`);
  
  for (let i = 0; i < validationQueues.length; i++) {
    const q = validationQueues[i];
    // Fetch waiting, delayed, and active jobs
    // We fetch ALL because duplicates might be spread across states
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    console.log(`Queue ${i}: Found ${jobs.length} jobs`);
    
    for (const j of jobs) {
      const mid = Number(j.data?.masterId);
      if (!mid) continue;
      
      const state = await j.getState(); // active, waiting, delayed, etc.
      if (!map.has(mid)) map.set(mid, []);
      
      map.get(mid)?.push({ 
        queueIdx: i, 
        job: j, 
        state: String(state),
        id: j.id || ''
      });
      totalFound++;
    }
  }

  console.log(`Total jobs scanned: ${totalFound}. Analyzing duplicates...`);

  let removedCount = 0;
  let uniqueCount = 0;

  // 2. Identify and remove duplicates
  for (const [mid, entries] of map.entries()) {
    uniqueCount++;
    
    if (entries.length <= 1) continue;

    // Sort entries to determine which one to KEEP
    // Priority:
    // 1. 'active' (Don't kill a running job)
    // 2. 'waiting' (Standard queue)
    // 3. 'delayed' (Retry or delayed)
    entries.sort((a, b) => {
      const score = (s: string) => {
        if (s === 'active') return 3;
        if (s === 'waiting') return 2;
        if (s === 'delayed') return 1;
        return 0;
      };
      return score(b.state) - score(a.state);
    });

    // Keep the first one (highest priority)
    const toKeep = entries[0];
    const toRemove = entries.slice(1);

    // console.log(`MasterID ${mid}: Keeping ${toKeep.state} in Q${toKeep.queueIdx}. Removing ${toRemove.length} duplicates.`);

    for (const item of toRemove) {
      try {
        await item.job.remove();
        removedCount++;
        if (removedCount % 100 === 0) process.stdout.write('.');
      } catch (e) {
        console.error(`Failed to remove job ${item.id}:`, e);
      }
    }
  }

  console.log('\n-----------------------------------');
  console.log('Cleanup Complete.');
  console.log(`Unique Emails: ${uniqueCount}`);
  console.log(`Duplicates Removed: ${removedCount}`);
  console.log('-----------------------------------');
  
  process.exit(0);
}

clean().catch(e => {
  console.error(e);
  process.exit(1);
});
