import { dedupeQueue, filterQueue, personalQueue, validationQueue, validationQueues } from '../queues';

async function cleanQueue(q: any, name: string) {
    console.log(`Cleaning queue: ${name}...`);
    try {
        const cleanedCompleted = await q.clean(0, 100000, 'completed');
        const cleanedFailed = await q.clean(0, 100000, 'failed');
        console.log(`[${name}] Cleaned ${cleanedCompleted.length} completed and ${cleanedFailed.length} failed jobs.`);
    } catch (e) {
        console.error(`[${name}] Error cleaning queue:`, e);
    }
}

async function run() {
    console.log('Starting targeted Redis cleanup of BullMQ jobs...');
    
    await cleanQueue(dedupeQueue, 'dedupe');
    await cleanQueue(filterQueue, 'filter');
    await cleanQueue(personalQueue, 'personal');
    await cleanQueue(validationQueue, 'validationMain');

    for (let i = 0; i < validationQueues.length; i++) {
        await cleanQueue(validationQueues[i], `validation_${i}`);
    }

    console.log('Cleanup finished.');
    process.exit(0);
}

run().catch(e => {
    console.error('Fatal error during cleanup:', e);
    process.exit(1);
});
