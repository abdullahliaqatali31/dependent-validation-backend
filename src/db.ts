import { Pool } from 'pg';
import { config } from './config';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Default max is 10 — too low for filterWorker (concurrency 10) + N validation workers +
  // queueWatcher + API all issuing per-row queries. Tune via PG_POOL_MAX (default 20).
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000),
});

// Don't let an idle-client error crash the process; log and let the pool recycle it.
pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

export async function query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(text: string, params?: any[]): Promise<import('pg').QueryResult<T>>{
  return pool.query<T>(text, params as any);
}

export async function withTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}