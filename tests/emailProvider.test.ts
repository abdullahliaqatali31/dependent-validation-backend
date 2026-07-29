import { providerFromMx, primaryMxHost, parseMxHosts, providerFromHosts, providerFromSpf } from '../src/utils/emailProvider';

describe('providerFromMx', () => {
  it('identifies Google Workspace MX hosts', () => {
    expect(providerFromMx('aspmx.l.google.com')).toBe('google_workspace');
    expect(providerFromMx('alt1.aspmx.l.google.com')).toBe('google_workspace');
    expect(providerFromMx('alt4.aspmx.l.google.com')).toBe('google_workspace');
    expect(providerFromMx('aspmx2.googlemail.com')).toBe('google_workspace');
    expect(providerFromMx('aspmx5.googlemail.com')).toBe('google_workspace');
    expect(providerFromMx('smtp.google.com')).toBe('google_workspace');
  });

  it('separates consumer Gmail from Workspace tenants', () => {
    expect(providerFromMx('gmail-smtp-in.l.google.com')).toBe('google_consumer');
    // gmail.com publishes alt1..alt4 variants too; these must not fall through to the Workspace rule.
    expect(providerFromMx('alt1.gmail-smtp-in.l.google.com')).toBe('google_consumer');
    expect(providerFromHosts([
      'gmail-smtp-in.l.google.com',
      'alt1.gmail-smtp-in.l.google.com',
      'alt4.gmail-smtp-in.l.google.com',
    ])).toBe('google_consumer');
  });

  it('identifies Microsoft 365 MX hosts', () => {
    expect(providerFromMx('contoso-com.mail.protection.outlook.com')).toBe('microsoft_365');
    expect(providerFromMx('acme.mail.eo.outlook.com')).toBe('microsoft_365');
  });

  it('identifies security gateways that mask the real provider', () => {
    expect(providerFromMx('mx1.emea.pphosted.com')).toBe('gateway');
    expect(providerFromMx('us-smtp-inbound-1.mimecast.com')).toBe('gateway');
    expect(providerFromMx('cust1234.ess.barracudanetworks.com')).toBe('gateway');
  });

  it('falls back to other for a known-but-unclassified host', () => {
    expect(providerFromMx('mx.zoho.com')).toBe('other');
    expect(providerFromMx('mailstore1.secureserver.net')).toBe('other');
  });

  it('returns unknown when no usable mx is present', () => {
    expect(providerFromMx(null)).toBe('unknown');
    expect(providerFromMx('')).toBe('unknown');
    expect(providerFromMx('   ')).toBe('unknown');
    expect(providerFromMx('localhost')).toBe('unknown');
  });

  it('normalizes preference numbers, trailing dots and case', () => {
    expect(providerFromMx('10 ASPMX.L.GOOGLE.COM.')).toBe('google_workspace');
  });

  it('prefers the real provider over a gateway when both are listed', () => {
    expect(providerFromMx('mx1.pphosted.com, aspmx.l.google.com')).toBe('google_workspace');
    expect(providerFromMx('mx1.pphosted.com alt1.aspmx.l.google.com')).toBe('google_workspace');
  });

  it('reports the host that determined the identity', () => {
    expect(primaryMxHost('10 mx1.pphosted.com, 20 aspmx.l.google.com')).toBe('aspmx.l.google.com');
    expect(primaryMxHost(null)).toBeNull();
  });

  it('parses multi-host mx values', () => {
    expect(parseMxHosts('a.google.com, b.google.com')).toEqual(['a.google.com', 'b.google.com']);
    expect(parseMxHosts(null)).toEqual([]);
  });
});

describe('providerFromHosts (DNS resolveMx results)', () => {
  it('classifies a standard Google Workspace record set', () => {
    expect(providerFromHosts([
      'aspmx.l.google.com',
      'alt1.aspmx.l.google.com',
      'aspmx2.googlemail.com',
    ])).toBe('google_workspace');
  });

  it('classifies a domain publishing only googlemail hosts', () => {
    // The client's `"google.com" in host` substring check misses these; suffix matching does not.
    expect(providerFromHosts(['aspmx2.googlemail.com', 'aspmx3.googlemail.com'])).toBe('google_workspace');
  });

  it('classifies Microsoft 365 and strips trailing dots', () => {
    expect(providerFromHosts(['contoso-com.mail.protection.outlook.com.'])).toBe('microsoft_365');
  });

  it('returns unknown for an empty record set', () => {
    expect(providerFromHosts([])).toBe('unknown');
  });
});

describe('providerFromSpf', () => {
  it('sees Google Workspace behind a gateway', () => {
    expect(providerFromSpf(['v=spf1 include:_spf.google.com ~all'])).toBe('google_workspace');
  });

  it('sees Microsoft 365 behind a gateway', () => {
    expect(providerFromSpf(['v=spf1 include:spf.protection.outlook.com -all'])).toBe('microsoft_365');
  });

  it('ignores non-SPF TXT records', () => {
    expect(providerFromSpf(['google-site-verification=abc123'])).toBeNull();
  });

  it('returns null when SPF names no provider we recognise', () => {
    expect(providerFromSpf(['v=spf1 include:mailgun.org ~all'])).toBeNull();
    expect(providerFromSpf([])).toBeNull();
  });
});
