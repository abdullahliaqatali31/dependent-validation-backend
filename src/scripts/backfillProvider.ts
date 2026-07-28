// Backfill the mail-provider identity across all existing data.
//
// Safe to stop and re-run: every phase is idempotent and resumable. Nothing is mutated unless
// --apply is passed; the default is a dry run that only reports what would change.
//
//   npm run backfill:provider              # dry run, reports coverage + projected counts
//   npm run backfill:provider -- --apply   # perform the backfill
//
// Optional: --batch=<n> (default 50000) to tune the id-range batch size.

import { pool, query } from '../db';
import { providerFromMx, primaryMxHost, EmailProvider } from '../utils/emailProvider';

const ROW_TABLES = ['validation_results', 'final_business_emails', 'final_personal_emails', 'free_pool'] as const;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const BATCH = Number((args.find(a => a.startsWith('--batch=')) || '').split('=')[1] || 50000);

function log(...parts: any[]) {
  console.log(...parts);
}

async function reportCoverage() {
  const r = await query<{ total: string; with_mx: string; domains: string; domains_with_mx: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(mx) FILTER (WHERE mx <> '') AS with_mx,
            COUNT(DISTINCT lower(domain)) AS domains,
            COUNT(DISTINCT lower(domain)) FILTER (WHERE mx IS NOT NULL AND mx <> '') AS domains_with_mx
     FROM validation_results`
  );
  const row = r.rows[0];
  const total = Number(row?.total || 0);
  const withMx = Number(row?.with_mx || 0);
  log('--- validation_results coverage ---');
  log(`  rows              : ${total}`);
  log(`  rows with mx      : ${withMx}${total ? ` (${((withMx / total) * 100).toFixed(1)}%)` : ''}`);
  log(`  distinct domains  : ${Number(row?.domains || 0)}`);
  log(`  domains with mx   : ${Number(row?.domains_with_mx || 0)}`);
  return { total, withMx };
}

/** Phase 1 — resolve one provider per domain from the MX already captured during validation. */
async function buildDomainProvider(): Promise<Map<EmailProvider, number>> {
  const tally = new Map<EmailProvider, number>();
  let cursor = '';
  let seen = 0;

  for (;;) {
    const r = await query<{ domain: string; mx: string }>(
      `SELECT DISTINCT ON (lower(domain)) lower(domain) AS domain, mx
       FROM validation_results
       WHERE domain IS NOT NULL AND domain <> ''
         AND mx IS NOT NULL AND mx <> ''
         AND lower(domain) > $1
       ORDER BY lower(domain), validated_at DESC
       LIMIT $2`,
      [cursor, 5000]
    );
    if (r.rows.length === 0) break;

    const rows = r.rows.map(row => {
      const provider = providerFromMx(row.mx);
      tally.set(provider, (tally.get(provider) || 0) + 1);
      return { domain: row.domain, provider, mxHost: primaryMxHost(row.mx) };
    });

    if (APPLY) {
      const values: string[] = [];
      const params: any[] = [];
      rows.forEach((row, i) => {
        const b = i * 3;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3}, 'validation_mx', now(), now())`);
        params.push(row.domain, row.provider, row.mxHost);
      });
      await query(
        `INSERT INTO domain_provider(domain, provider, mx_host, source, checked_at, updated_at)
         VALUES ${values.join(',')}
         ON CONFLICT (domain) DO UPDATE
           SET provider = EXCLUDED.provider,
               mx_host = EXCLUDED.mx_host,
               source = EXCLUDED.source,
               updated_at = now()`,
        params
      );
    }

    seen += r.rows.length;
    cursor = r.rows[r.rows.length - 1].domain;
    if (seen % 25000 === 0) log(`  ...resolved ${seen} domains`);
  }

  log(`  resolved ${seen} domains`);
  return tally;
}

async function idRange(table: string) {
  const r = await query<{ lo: string | null; hi: string | null }>(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM ${table}`);
  return { lo: Number(r.rows[0]?.lo || 0), hi: Number(r.rows[0]?.hi || 0) };
}

/** Phase 2 — stamp the domain's provider onto each row table, in id-range batches. */
async function applyToTable(table: string) {
  const { lo, hi } = await idRange(table);
  if (!hi) {
    log(`  ${table}: empty, skipped`);
    return;
  }
  let updated = 0;
  for (let start = lo; start <= hi; start += BATCH) {
    const end = start + BATCH;
    const r = await query(
      `UPDATE ${table} t
       SET provider = dp.provider
       FROM domain_provider dp
       WHERE lower(t.domain) = dp.domain
         AND t.id >= $1 AND t.id < $2
         AND t.provider IS DISTINCT FROM dp.provider`,
      [start, end]
    );
    updated += r.rowCount || 0;
  }
  // Domains we have no MX for at all still need a definite identity so the UI has no NULL bucket.
  // A later DNS pass can upgrade these in place.
  let marked = 0;
  for (let start = lo; start <= hi; start += BATCH) {
    const r = await query(`UPDATE ${table} SET provider = 'unknown' WHERE provider IS NULL AND id >= $1 AND id < $2`, [start, start + BATCH]);
    marked += r.rowCount || 0;
  }
  log(`  ${table}: ${updated} classified, ${marked} marked unknown`);
}

/** Phase 3 — indexes built CONCURRENTLY so they never block the running pipeline. */
async function createIndexes() {
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

async function reportFinal() {
  for (const t of ROW_TABLES) {
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

async function main() {
  log(`\n=== provider backfill (${APPLY ? 'APPLY' : 'DRY RUN'}, batch=${BATCH}) ===\n`);

  await reportCoverage();

  log('\n--- phase 1: resolve provider per domain ---');
  const tally = await buildDomainProvider();
  log('  projected domain identities:');
  for (const [p, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) log(`    ${p.padEnd(18)} ${n}`);

  if (!APPLY) {
    log('\nDry run complete. No data was modified. Re-run with --apply to perform the backfill.\n');
    return;
  }

  log('\n--- phase 2: apply to row tables ---');
  for (const t of ROW_TABLES) await applyToTable(t);

  log('\n--- phase 3: indexes ---');
  await createIndexes();

  log('\n--- final counts ---');
  await reportFinal();
  log('\nBackfill complete.\n');
}

main()
  .catch(e => {
    console.error('backfill failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
