import { query } from '../db';
import { redis } from '../redis';

type CacheEntry = { value: boolean; expires: number };
const emailCache = new Map<string, CacheEntry>();
const domainCache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// Workers run in a separate process from the API, so an admin edit/delete can't clear their
// in-memory cache directly. The API bumps this Redis counter on every change; each process
// polls it at most every VERSION_CHECK_MS and drops its cache when the value moves.
const VERSION_KEY = 'unsub:version';
const VERSION_CHECK_MS = 10_000;
let seenVersion: string | null | undefined;
let lastVersionCheck = 0;

async function syncCacheVersion(): Promise<void> {
  const now = Date.now();
  if (now - lastVersionCheck < VERSION_CHECK_MS) return;
  lastVersionCheck = now;
  try {
    const v = await redis.get(VERSION_KEY);
    if (seenVersion !== undefined && v !== seenVersion) {
      emailCache.clear();
      domainCache.clear();
    }
    seenVersion = v;
  } catch { /* Redis down: fall back to TTL expiry */ }
}

export async function isUnsubscribedEmail(email: string): Promise<boolean> {
  await syncCacheVersion();
  const now = Date.now();
  const cached = emailCache.get(email);
  if (cached && cached.expires > now) return cached.value;
  const r = await query<{ email: string }>('SELECT email FROM unsubscribe_list WHERE email=$1', [email]);
  const value = r.rows.length > 0;
  emailCache.set(email, { value, expires: now + TTL_MS });
  return value;
}

export async function isUnsubscribedDomain(domain: string): Promise<boolean> {
  await syncCacheVersion();
  const now = Date.now();
  const cached = domainCache.get(domain);
  if (cached && cached.expires > now) return cached.value;
  const r = await query<{ domain: string }>('SELECT domain FROM unsubscribe_domains WHERE domain=$1', [domain]);
  const value = r.rows.length > 0;
  domainCache.set(domain, { value, expires: now + TTL_MS });
  return value;
}

export async function isUnsubscribed(email: string, domain: string): Promise<boolean> {
  const [e, d] = await Promise.all([isUnsubscribedEmail(email), isUnsubscribedDomain(domain)]);
  return e || d;
}

export function invalidateUnsubscribeCache(email?: string, domain?: string): void {
  if (email) emailCache.delete(email);
  if (domain) domainCache.delete(domain);
}

/** Call after any edit/delete/restore so every process (API + workers) drops stale entries. */
export async function bumpUnsubscribeVersion(): Promise<void> {
  emailCache.clear();
  domainCache.clear();
  try { await redis.incr(VERSION_KEY); } catch { /* workers fall back to TTL expiry */ }
}
