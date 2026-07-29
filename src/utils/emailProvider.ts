// Mail-provider identity derived from a domain's MX host.
//
// Provider is a property of the DOMAIN, not of the individual address, so it is resolved once per
// domain (see domain_provider) and then applied to every row that shares that domain. Keeping a
// single provider per domain is what lets the validation, split and free-pool views agree.

export type EmailProvider =
  | 'google_workspace'
  | 'google_consumer'
  | 'microsoft_365'
  | 'gateway'
  | 'other'
  | 'unknown';

export const EMAIL_PROVIDERS: EmailProvider[] = [
  'google_workspace',
  'google_consumer',
  'microsoft_365',
  'gateway',
  'other',
  'unknown',
];

// Consumer Gmail sits on Google infrastructure but is not a Workspace tenant. It is separated so
// the Google Workspace segment is self-contained and does not need a category filter to be correct.
// Matched as a suffix: gmail.com publishes gmail-smtp-in.l.google.com plus alt1..alt4 variants, and
// matching only the bare host would let the alt records fall through to the Workspace rule below.
const GOOGLE_CONSUMER_HOST = 'gmail-smtp-in.l.google.com';

function isGoogleConsumerHost(host: string): boolean {
  return host === GOOGLE_CONSUMER_HOST || host.endsWith('.' + GOOGLE_CONSUMER_HOST);
}

const GOOGLE_SUFFIXES = ['.l.google.com', '.googlemail.com', '.google.com'];
const GOOGLE_HOSTS = new Set(['smtp.google.com', 'aspmx.l.google.com']);

const MICROSOFT_SUFFIXES = [
  '.mail.protection.outlook.com',
  '.mail.eo.outlook.com',
  '.olc.protection.outlook.com',
  '.protection.outlook.com',
  '.mail.messaging.microsoft.com',
  '.outlook.com',
];

// Security gateways terminate MX in front of the real mailbox, so they mask whether the tenant is
// actually Google or Microsoft underneath. They get their own identity rather than being guessed at;
// an SPF lookup can resolve many of them later.
const GATEWAY_SUFFIXES = [
  '.pphosted.com',
  '.ppe-hosted.com',
  '.mimecast.com',
  '.mimecast.co.za',
  '.barracudanetworks.com',
  '.iphmx.com',
  '.sophos.com',
  '.tmes.trendmicro.com',
  '.trendmicro.com',
  '.mailcontrol.com',
  '.messagelabs.com',
  '.securence.com',
  '.fireeyecloud.com',
];

function normalizeHost(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    // MX values are sometimes stored with their preference number ("10 aspmx.l.google.com").
    .replace(/^\d+\s+/, '')
    .replace(/\.$/, '');
}

/** Split a stored mx value into individual hosts. Ninja returns one host, but be tolerant. */
export function parseMxHosts(mx: string | null | undefined): string[] {
  if (!mx) return [];
  return String(mx)
    .split(/[,;\s]+/)
    .map(normalizeHost)
    .filter(h => h.length > 0 && h.includes('.'));
}

function classifyHost(host: string): EmailProvider {
  if (!host) return 'unknown';
  if (isGoogleConsumerHost(host)) return 'google_consumer';
  if (GOOGLE_HOSTS.has(host) || GOOGLE_SUFFIXES.some(s => host.endsWith(s))) return 'google_workspace';
  if (MICROSOFT_SUFFIXES.some(s => host.endsWith(s))) return 'microsoft_365';
  if (GATEWAY_SUFFIXES.some(s => host.endsWith(s))) return 'gateway';
  return 'other';
}

// A domain fronted by a gateway may still list a real provider host; the real provider wins.
const PRECEDENCE: EmailProvider[] = ['google_workspace', 'microsoft_365', 'google_consumer', 'other', 'gateway'];

/** Resolve a provider identity from a list of MX hostnames (e.g. a DNS resolveMx result). */
export function providerFromHosts(hosts: string[]): EmailProvider {
  const normalized = hosts.map(normalizeHost).filter(h => h.length > 0 && h.includes('.'));
  if (normalized.length === 0) return 'unknown';
  const seen = new Set<EmailProvider>(normalized.map(classifyHost));
  for (const p of PRECEDENCE) {
    if (seen.has(p)) return p;
  }
  return 'unknown';
}

/** Resolve a provider identity from one or more MX hosts. */
export function providerFromMx(mx: string | null | undefined): EmailProvider {
  return providerFromHosts(parseMxHosts(mx));
}

// A gateway terminates MX in front of the real mailbox, so MX alone cannot tell us who is behind it.
// The SPF record usually still names the true provider, which is the only cheap way to recover them.
const SPF_SIGNATURES: { match: string; provider: EmailProvider }[] = [
  { match: '_spf.google.com', provider: 'google_workspace' },
  { match: 'spf.protection.outlook.com', provider: 'microsoft_365' },
  { match: 'spf.messaging.microsoft.com', provider: 'microsoft_365' },
];

/**
 * Inspect SPF TXT records for a provider signature.
 * Returns null when SPF is absent or names no provider we recognise — the caller should then keep
 * whatever identity MX already gave it rather than guessing.
 */
export function providerFromSpf(txtRecords: string[]): EmailProvider | null {
  const spf = txtRecords.map(r => String(r || '').trim().toLowerCase()).filter(r => r.startsWith('v=spf1'));
  if (spf.length === 0) return null;
  const joined = spf.join(' ');
  // Google is checked first: a tenant fronted by Microsoft-branded filtering can still list both.
  for (const sig of SPF_SIGNATURES) {
    if (joined.includes(sig.match)) return sig.provider;
  }
  return null;
}

/** The MX host that determined the provider, for auditability. */
export function primaryMxHost(mx: string | null | undefined): string | null {
  const hosts = parseMxHosts(mx);
  if (hosts.length === 0) return null;
  const winner = providerFromMx(mx);
  return hosts.find(h => classifyHost(h) === winner) || hosts[0];
}
