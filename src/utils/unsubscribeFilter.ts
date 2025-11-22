import { query } from '../db';

export async function isUnsubscribedEmail(email: string): Promise<boolean> {
  const r = await query<{ email: string }>('SELECT email FROM unsubscribe_list WHERE email=$1', [email]);
  return r.rows.length > 0;
}

export async function isUnsubscribedDomain(domain: string): Promise<boolean> {
  const r = await query<{ domain: string }>('SELECT domain FROM unsubscribe_domains WHERE domain=$1', [domain]);
  return r.rows.length > 0;
}

export async function isUnsubscribed(email: string, domain: string): Promise<boolean> {
  const [e, d] = await Promise.all([isUnsubscribedEmail(email), isUnsubscribedDomain(domain)]);
  return e || d;
}