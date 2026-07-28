import { providerFromMx, primaryMxHost, parseMxHosts } from '../src/utils/emailProvider';

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
