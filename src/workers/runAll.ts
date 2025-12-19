// Start all workers by importing their modules
import '../workers/dedupeWorker';
import '../workers/filterWorker';
import '../workers/personalWorker';
import '../workers/validationMulti';
import '../workers/queueWatcher';
import { query } from '../db';
import { config } from '../config';

(async () => {
  try {
    for (const k of (config.ninjaKeys || [])) {
      await query(
        `INSERT INTO ninja_keys(key, status, total_requests, total_success, total_failed, consecutive_errors)
         VALUES ($1, 'active', 0, 0, 0, 0)
         ON CONFLICT (key) DO NOTHING`,
        [k]
      );
    }
    console.log(`Seeded ${config.ninjaKeys.length} ninja keys`);
  } catch (e) {
    console.log('Seed ninja keys failed:', (e as any)?.message || e);
  }
})();

console.log('All workers initialized');
