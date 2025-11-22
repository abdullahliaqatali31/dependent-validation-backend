import { cleanEmail } from '../../utils/emailCleaner';

describe('filter routing decision', () => {
  test('removed emails should not proceed', () => {
    const r = cleanEmail('noreply@domain.com', { contains: ['noreply'], endswith: [], domains: [], excludes: [] });
    expect(String(r.status).startsWith('removed:')).toBeTruthy();
    expect(r.cleaned).toBeNull();
  });

  test('clean or repaired should proceed', () => {
    const r = cleanEmail('user@site.c', { contains: [], endswith: [], domains: [], excludes: [] });
    expect(r.cleaned).toBe('user@site.com');
    expect(r.status === 'clean' || r.status.startsWith('repaired:')).toBeTruthy();
  });
});

