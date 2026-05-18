import { query } from '../db';

type CacheEntry = { value: boolean; expires: number };
const emailCache = new Map<string, CacheEntry>();
const domainCache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function isUnsubscribedEmail(email: string): Promise<boolean> {
  const now = Date.now();
  const cached = emailCache.get(email);
  if (cached && cached.expires > now) return cached.value;
  const r = await query<{ email: string }>('SELECT email FROM unsubscribe_list WHERE email=$1', [email]);
  const value = r.rows.length > 0;
  emailCache.set(email, { value, expires: now + TTL_MS });
  return value;
}

export async function isUnsubscribedDomain(domain: string): Promise<boolean> {
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
