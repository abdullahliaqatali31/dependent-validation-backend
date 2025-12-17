import { query } from '../db';
import { config } from '../config';

async function sync() {
  const keys = config.ninjaKeys;
  console.log(`Found ${keys.length} keys in environment configuration.`);

  if (keys.length === 0) {
    console.log('No keys found. Please set NINJA_KEYS in .env (comma-separated).');
    process.exit(0);
  }

  let added = 0;
  for (const key of keys) {
    const cleanKey = key.trim();
    if (!cleanKey) continue;

    // We use ON CONFLICT DO NOTHING so we don't duplicate or error out on existing keys
    const res = await query(
      `INSERT INTO ninja_keys (key, status) VALUES ($1, 'active') ON CONFLICT (key) DO NOTHING`,
      [cleanKey]
    );
    if (res.rowCount && res.rowCount > 0) {
      added++;
    }
  }

  console.log(`Sync complete. Added ${added} new keys.`);
  
  // Show current count
  const count = await query('SELECT COUNT(*) FROM ninja_keys');
  console.log(`Total keys in database: ${count.rows[0].count}`);
  
  process.exit(0);
}

sync().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
