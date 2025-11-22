import { cleanEmail } from '../../utils/emailCleaner';

describe('cleanEmail', () => {
  const rules = {
    contains: ['noreply', 'k12'],
    endswith: ['.gov', '.edu'],
    domains: ['example.com'],
    excludes: ['trashmail']
  };

  test('removes garbage and validates format', () => {
    const r = cleanEmail('mailto:"John" <User@Example.c>', { contains: [], endswith: [], domains: [], excludes: [] });
    expect(r.cleaned).toBe('user@example.com');
    expect(r.status.startsWith('repaired:')).toBeTruthy();
  });

  test('contains keyword removal', () => {
    const r = cleanEmail('support+noreply@gmail.com', rules);
    expect(r.cleaned).toBeNull();
    expect(r.status).toBe('removed:contains_keyword');
  });

  test('endswith rule removal on domain', () => {
    const r = cleanEmail('admin@agency.gov', rules);
    expect(r.cleaned).toBeNull();
    expect(r.status).toBe('removed:endswith_rule');
  });

  test('domain rule exact match removal', () => {
    const r = cleanEmail('ceo@example.com', rules);
    expect(r.cleaned).toBeNull();
    expect(r.status).toBe('removed:domain_rule');
  });

  test('invalid format removed', () => {
    const r = cleanEmail('invalid_email_without_at', { contains: [], endswith: [], domains: [], excludes: [] });
    expect(r.cleaned).toBeNull();
    expect(r.status).toBe('removed:no_at_symbol');
  });

  test('tld garbage strip', () => {
    const r = cleanEmail('john@company.comxyz', { contains: [], endswith: [], domains: [], excludes: [] });
    expect(r.cleaned).toBe('john@company.com');
    expect(r.status.startsWith('repaired:')).toBeTruthy();
  });
});

