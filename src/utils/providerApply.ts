// Shared "stamp domain_provider onto the row tables" step.
//
// Used by both the initial backfill (which sources identities from Ninja's stored mx) and the DNS
// resolver (which fills in whatever Ninja never answered for). Both end up needing the exact same
// apply pass, so it lives here rather than being duplicated and drifting.

import { query } from '../db';

export const PROVIDER_ROW_TABLES = [
  'validation_results',
  'final_business_emails',
  'final_personal_emails',
  'free_pool',
] as const;

type Logger = (...parts: any[]) => void;

async function idRange(table: string) {
  const r = await query<{ lo: string | null; hi: string | null }>(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM ${table}`);
  return { lo: Number(r.rows[0]?.lo || 0), hi: Number(r.rows[0]?.hi || 0) };
}

/**
 * Copy each domain's identity onto its rows, in id-range batches.
 * Only rows whose provider actually differs are written, so re-running is cheap and does not
 * needlessly rewrite (and bloat) a large table.
 */
export async function applyProviderToTable(table: string, batchSize: number, log: Logger, markUnknown = true) {
  const { lo, hi } = await idRange(table);
  if (!hi) {
    log(`  ${table}: empty, skipped`);
    return { updated: 0, marked: 0 };
  }
  let updated = 0;
  for (let start = lo; start <= hi; start += batchSize) {
    const r = await query(
      `UPDATE ${table} t
       SET provider = dp.provider
       FROM domain_provider dp
       WHERE lower(t.domain) = dp.domain
         AND t.id >= $1 AND t.id < $2
         AND t.provider IS DISTINCT FROM dp.provider`,
      [start, start + batchSize]
    );
    updated += r.rowCount || 0;
  }

  let marked = 0;
  if (markUnknown) {
    // Domains we still have no identity for need a definite value so the UI has no NULL bucket.
    // A later resolver run can upgrade these in place.
    for (let start = lo; start <= hi; start += batchSize) {
      const r = await query(
        `UPDATE ${table} SET provider = 'unknown' WHERE provider IS NULL AND id >= $1 AND id < $2`,
        [start, start + batchSize]
      );
      marked += r.rowCount || 0;
    }
  }

  log(`  ${table}: ${updated} classified, ${marked} marked unknown`);
  return { updated, marked };
}

export async function applyProviderToAllTables(batchSize: number, log: Logger, markUnknown = true) {
  for (const t of PROVIDER_ROW_TABLES) await applyProviderToTable(t, batchSize, log, markUnknown);
}

/** Indexes are built CONCURRENTLY so they never block the running pipeline. */
export async function createProviderIndexes(log: Logger) {
  const stmts = [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vr_category_outcome_provider ON validation_results(category, outcome, provider)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fbe_provider ON final_business_emails(provider)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fpe_provider ON final_personal_emails(provider)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fp_provider ON free_pool(category, outcome, provider)`,
  ];
  for (const s of stmts) {
    const name = s.match(/idx_[a-z_]+/)?.[0] || s;
    try {
      await query(s);
      log(`  ${name} ok`);
    } catch (e: any) {
      log(`  ${name} failed: ${e?.message || e}`);
    }
  }
}

export async function reportProviderCounts(log: Logger) {
  for (const t of PROVIDER_ROW_TABLES) {
    const r = await query<{ provider: string | null; c: string }>(
      `SELECT provider, COUNT(*) AS c FROM ${t} GROUP BY provider ORDER BY COUNT(*) DESC`
    );
    log(`  ${t}: ` + (r.rows.map(x => `${x.provider || 'NULL'}=${x.c}`).join('  ') || '(empty)'));
  }
  const biz = await query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM validation_results WHERE category='business' AND provider='google_workspace'`
  );
  log(`\n  business + google_workspace: ${Number(biz.rows[0]?.c || 0)}`);
}
