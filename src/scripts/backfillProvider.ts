// Backfill the mail-provider identity from the MX that Ninja already returned during validation.
//
// This covers every domain we have an mx for, at no API cost. Domains Ninja never answered for are
// left as 'unknown' — run `npm run resolve:domains` afterwards to fill those in via DNS.
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
import { applyProviderToAllTables, createProviderIndexes, reportProviderCounts } from '../utils/providerApply';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const BATCH = Number((args.find(a => a.startsWith('--batch=')) || '').split('=')[1] || 50000);

function log(...parts: any[]) {
  console.log(...parts);
}

async function reportCoverage() {
  // master_emails is the full universe — it holds every deduped address, including ones that never
  // reached validation. Comparing against it shows how much of the database this pass can reach.
  const r = await query<{
    total: string; with_mx: string; vr_domains: string; domains_with_mx: string; master_domains: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM validation_results)                                                  AS total,
       (SELECT COUNT(*) FROM validation_results WHERE mx IS NOT NULL AND mx <> '')                AS with_mx,
       (SELECT COUNT(DISTINCT lower(domain)) FROM validation_results)                             AS vr_domains,
       (SELECT COUNT(DISTINCT lower(domain)) FROM validation_results
          WHERE mx IS NOT NULL AND mx <> '')                                                      AS domains_with_mx,
       (SELECT COUNT(DISTINCT lower(domain)) FROM master_emails WHERE domain IS NOT NULL)         AS master_domains`
  );
  const row = r.rows[0];
  const total = Number(row?.total || 0);
  const withMx = Number(row?.with_mx || 0);
  const vrDomains = Number(row?.vr_domains || 0);
  const withMxDomains = Number(row?.domains_with_mx || 0);
  const masterDomains = Number(row?.master_domains || 0);

  const pct = (n: number, d: number) => (d ? ` (${((n / d) * 100).toFixed(1)}%)` : '');
  log('--- coverage ---');
  log(`  validation rows            : ${total}`);
  log(`  validation rows with mx    : ${withMx}${pct(withMx, total)}`);
  log(`  domains in master_emails   : ${masterDomains}   <- the full universe`);
  log(`  domains in validation      : ${vrDomains}${pct(vrDomains, masterDomains)}`);
  log(`  domains with mx (this pass): ${withMxDomains}${pct(withMxDomains, masterDomains)}`);
  const gap = masterDomains - withMxDomains;
  if (gap > 0) log(`  domains needing DNS        : ${gap}${pct(gap, masterDomains)}   <- run resolve:domains`);
}

/** Phase 1 — resolve one provider per domain from the MX captured during validation. */
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

async function main() {
  log(`\n=== provider backfill (${APPLY ? 'APPLY' : 'DRY RUN'}, batch=${BATCH}) ===\n`);

  await reportCoverage();

  log('\n--- phase 1: resolve provider per domain (from Ninja mx) ---');
  const tally = await buildDomainProvider();
  log('  projected domain identities:');
  for (const [p, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) log(`    ${p.padEnd(18)} ${n}`);

  if (!APPLY) {
    log('\nDry run complete. No data was modified. Re-run with --apply to perform the backfill.\n');
    return;
  }

  log('\n--- phase 2: apply to row tables ---');
  await applyProviderToAllTables(BATCH, log);

  log('\n--- phase 3: indexes ---');
  await createProviderIndexes(log);

  log('\n--- final counts ---');
  await reportProviderCounts(log);
  log('\nBackfill complete. Run `npm run resolve:domains` to classify domains Ninja had no mx for.\n');
}

main()
  .catch(e => {
    console.error('backfill failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
