// Resolve mail-provider identity by direct DNS lookup, for every domain in the database.
//
// This is the completeness pass. backfillProvider only reaches domains Ninja returned an mx for;
// this one enumerates the FULL domain universe from master_emails, so domains whose emails timed
// out, errored, or never reached validation still get an identity.
//
// It runs entirely outside the pipeline — no Ninja credits, no interaction with the validation
// lock — so it is safe to run while the system is live.
//
//   npm run resolve:domains                    # dry run: counts + a small live sample
//   npm run resolve:domains -- --apply         # resolve everything outstanding
//   npm run resolve:domains -- --apply --spf   # also try SPF on gateway-masked domains
//
// Flags: --concurrency=<n> (50)  --timeout=<ms> (5000)  --servers=1.1.1.1,8.8.8.8
//        --limit=<n>  --sample=<n> (500)  --batch=<n> (50000)  --stale=<days>

import { Resolver } from 'dns/promises';
import { pool, query } from '../db';
import { EmailProvider, providerFromHosts, providerFromSpf } from '../utils/emailProvider';
import { applyProviderToAllTables, createProviderIndexes, reportProviderCounts } from '../utils/providerApply';

const args = process.argv.slice(2);
const flag = (name: string, dflt: number) => Number((args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1] || dflt);

const APPLY = args.includes('--apply');
const SPF_MODE = args.includes('--spf');
const CONCURRENCY = flag('concurrency', 50);
const TIMEOUT = flag('timeout', 5000);
const SAMPLE = flag('sample', 500);
const LIMIT = flag('limit', 0);
const BATCH = flag('batch', 50000);
const STALE_DAYS = flag('stale', 0);
const SERVERS = (args.find(a => a.startsWith('--servers=')) || '').split('=')[1];

const PAGE = 2000;

function log(...parts: any[]) {
  console.log(...parts);
}

// Public resolvers by default. Hammering a single upstream at high concurrency gets you throttled;
// spreading across three, with a hard timeout, keeps the run predictable.
const resolver = new Resolver({ timeout: TIMEOUT, tries: 2 });
resolver.setServers(SERVERS ? SERVERS.split(',').map(s => s.trim()).filter(Boolean) : ['1.1.1.1', '8.8.8.8', '9.9.9.9']);

// A domain that genuinely has no MX is a settled fact worth caching. A timeout or SERVFAIL is not —
// caching those would permanently mislabel a domain because of one bad moment on the network.
const DEFINITIVE_NO_MX = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

type Outcome = { domain: string; provider: EmailProvider; mxHost: string | null } | null;

async function resolveOne(domain: string): Promise<Outcome> {
  try {
    const records = await resolver.resolveMx(domain);
    const hosts = (records || []).sort((a, b) => a.priority - b.priority).map(r => r.exchange);
    if (hosts.length === 0) return { domain, provider: 'unknown', mxHost: null };
    return { domain, provider: providerFromHosts(hosts), mxHost: String(hosts[0] || '').toLowerCase().replace(/\.$/, '') || null };
  } catch (e: any) {
    const code = String(e?.code || '').toUpperCase();
    if (DEFINITIVE_NO_MX.has(code)) return { domain, provider: 'unknown', mxHost: null };
    return null; // transient — leave it for the next run rather than poisoning the cache
  }
}

/** SPF can name the true provider behind a security gateway. Returns null when it is inconclusive. */
async function resolveSpf(domain: string): Promise<Outcome> {
  try {
    const txt = await resolver.resolveTxt(domain);
    const flat = (txt || []).map(parts => parts.join(''));
    const provider = providerFromSpf(flat);
    return provider ? { domain, provider, mxHost: null } : null;
  } catch {
    return null;
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function persist(outcomes: Outcome[], source: string) {
  const rows = outcomes.filter(Boolean) as NonNullable<Outcome>[];
  if (rows.length === 0) return;
  const values: string[] = [];
  const params: any[] = [];
  rows.forEach((row, i) => {
    const b = i * 4;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, now(), now())`);
    params.push(row.domain, row.provider, row.mxHost, source);
  });
  await query(
    `INSERT INTO domain_provider(domain, provider, mx_host, source, checked_at, updated_at)
     VALUES ${values.join(',')}
     ON CONFLICT (domain) DO UPDATE
       SET provider = EXCLUDED.provider,
           mx_host = COALESCE(EXCLUDED.mx_host, domain_provider.mx_host),
           source = EXCLUDED.source,
           checked_at = now(),
           updated_at = now()`,
    params
  );
}

/** Domains anywhere in the database that still have no usable identity. */
async function* outstandingDomains() {
  let cursor = '';
  for (;;) {
    const r = await query<{ domain: string }>(
      `SELECT d.domain FROM (
         SELECT DISTINCT lower(domain) AS domain
         FROM master_emails
         WHERE domain IS NOT NULL AND domain <> '' AND lower(domain) > $1
         ORDER BY 1
         LIMIT $2
       ) d
       LEFT JOIN domain_provider dp ON dp.domain = d.domain
       WHERE dp.domain IS NULL
          OR dp.provider = 'unknown'
          OR ($3 > 0 AND dp.checked_at < now() - ($3 || ' days')::interval)
       ORDER BY d.domain`,
      [cursor, PAGE, STALE_DAYS]
    );
    // The page is taken from master_emails before the join filter, so advance the cursor using the
    // widest domain scanned, not the widest returned — otherwise filtered pages would loop forever.
    const scanned = await query<{ domain: string }>(
      `SELECT lower(domain) AS domain FROM master_emails
       WHERE domain IS NOT NULL AND domain <> '' AND lower(domain) > $1
       ORDER BY lower(domain) LIMIT 1 OFFSET $2`,
      [cursor, PAGE - 1]
    );
    if (r.rows.length > 0) yield r.rows.map(x => x.domain);
    if (scanned.rows.length === 0) return;
    cursor = scanned.rows[0].domain;
  }
}

async function* gatewayDomains() {
  let cursor = '';
  for (;;) {
    const r = await query<{ domain: string }>(
      `SELECT domain FROM domain_provider
       WHERE provider = 'gateway' AND domain > $1
       ORDER BY domain LIMIT $2`,
      [cursor, PAGE]
    );
    if (r.rows.length === 0) return;
    yield r.rows.map(x => x.domain);
    cursor = r.rows[r.rows.length - 1].domain;
  }
}

async function reportScope() {
  const r = await query<{ master_domains: string; resolved: string; outstanding: string; gateways: string }>(
    `SELECT
       (SELECT COUNT(DISTINCT lower(domain)) FROM master_emails WHERE domain IS NOT NULL AND domain <> '') AS master_domains,
       (SELECT COUNT(*) FROM domain_provider WHERE provider <> 'unknown')                                  AS resolved,
       (SELECT COUNT(*) FROM domain_provider WHERE provider = 'unknown')                                   AS outstanding,
       (SELECT COUNT(*) FROM domain_provider WHERE provider = 'gateway')                                   AS gateways`
  );
  const row = r.rows[0];
  log('--- scope ---');
  log(`  distinct domains in master_emails : ${Number(row?.master_domains || 0)}`);
  log(`  already identified                : ${Number(row?.resolved || 0)}`);
  log(`  currently 'unknown'               : ${Number(row?.outstanding || 0)}`);
  log(`  gateway-masked (SPF candidates)   : ${Number(row?.gateways || 0)}`);
}

async function runPass(
  source: AsyncGenerator<string[]>,
  fn: (d: string) => Promise<Outcome>,
  sourceLabel: string,
  cap: number
) {
  const tally = new Map<string, number>();
  let processed = 0;
  let transient = 0;

  for await (const page of source) {
    const slice = cap > 0 ? page.slice(0, Math.max(0, cap - processed)) : page;
    if (slice.length === 0) break;

    const outcomes = await mapPool(slice, CONCURRENCY, fn);
    for (const o of outcomes) {
      if (!o) { transient++; continue; }
      tally.set(o.provider, (tally.get(o.provider) || 0) + 1);
    }
    if (APPLY) await persist(outcomes, sourceLabel);

    processed += slice.length;
    log(`  ...${processed} domains looked up (${transient} transient failures)`);
    if (cap > 0 && processed >= cap) break;
  }

  log(`  looked up ${processed} domains; ${transient} transient failures (will retry on next run)`);
  if (tally.size > 0) {
    log('  identities found:');
    for (const [p, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) log(`    ${p.padEnd(18)} ${n}`);
  }
  return processed;
}

async function main() {
  log(`\n=== domain resolver (${APPLY ? 'APPLY' : 'DRY RUN'}, concurrency=${CONCURRENCY}, timeout=${TIMEOUT}ms) ===\n`);
  await reportScope();

  const cap = APPLY ? LIMIT : Math.max(1, SAMPLE);
  if (!APPLY) log(`\nDry run: looking up a live sample of ${cap} domains to show the real distribution.`);

  log('\n--- MX pass ---');
  await runPass(outstandingDomains(), resolveOne, 'dns', cap);

  if (SPF_MODE) {
    log('\n--- SPF pass (gateway-masked domains) ---');
    await runPass(gatewayDomains(), resolveSpf, 'dns_spf', cap);
  }

  if (!APPLY) {
    log('\nDry run complete. No data was modified. Re-run with --apply to resolve everything.\n');
    return;
  }

  log('\n--- applying to row tables ---');
  await applyProviderToAllTables(BATCH, log);
  await createProviderIndexes(log);

  log('\n--- final counts ---');
  await reportProviderCounts(log);
  log('\nResolver complete.\n');
}

main()
  .catch(e => {
    console.error('resolver failed:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
