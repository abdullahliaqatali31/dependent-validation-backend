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
    '005_profiles_admin_override.sql',
    '018_ensure_profiles_trigger.sql',
    '019_ensure_handle_new_user_trigger.sql'
  ]);
  if (!supabaseEnabled) {
    const before = files.slice();
    files = files.filter(f => !supabaseOnly.has(f));
    const skipped = before.filter(f => !files.includes(f));
    if (skipped.length) {
      console.log('Skipping Supabase-only migrations:', skipped.join(', '));
    }
  } else {
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

  // Bootstrap: create applied_migrations table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Fetch already-applied migrations
  const appliedRes = await pool.query<{ filename: string }>('SELECT filename FROM applied_migrations');
  const applied = new Set(appliedRes.rows.map(r => r.filename));

  let ran = 0;
  let skipped = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  Skipping (already applied): ${file}`);
      skipped++;
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`\nApplying migration: ${file}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO applied_migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran++;
      console.log(`  Done: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(`\nMigrations completed. Applied: ${ran}, Skipped: ${skipped}.`);
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
