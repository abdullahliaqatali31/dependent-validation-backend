import fs from 'fs';
import path from 'path';
import { pool } from './db';
import { config } from './config';

async function run() {
  const migrationsDir = path.join(process.cwd(), 'migrations');
  let files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  // Skip Supabase-specific migrations unless explicitly enabled
  const supabaseEnabled = (process.env.SUPABASE_ENABLED || '').toLowerCase() === 'true'
    || (!!config.supabaseUrl && !!config.supabaseAnonKey);
  const supabaseOnly = new Set([
    '002_profiles.sql',
    '003_role_policies.sql',
    '004_profiles_backfill.sql',
    '005_profiles_admin_override.sql'
  ]);
  if (!supabaseEnabled) {
    const before = files.slice();
    files = files.filter(f => !supabaseOnly.has(f));
    const skipped = before.filter(f => !files.includes(f));
    if (skipped.length) {
      console.log('Skipping Supabase-only migrations:', skipped.join(', '));
    }
  } else {
    // Extra safety: if the connected DB does not have the 'auth' schema, skip Supabase-only migrations
    try {
      const res = await pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name='auth'");
      const hasAuth = (res?.rowCount || 0) > 0;
      if (!hasAuth) {
        const before = files.slice();
        files = files.filter(f => !supabaseOnly.has(f));
        const skipped = before.filter(f => !files.includes(f));
        if (skipped.length) {
          console.log("Skipping Supabase-only migrations (no 'auth' schema):", skipped.join(', '));
        }
      }
    } catch {}
  }
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`\nApplying migration: ${file}`);
    await pool.query(sql);
  }
  console.log('\nMigrations completed.');
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});