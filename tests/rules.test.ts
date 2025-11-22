import { matchRules } from '../src/utils/rules';

describe('matchRules', () => {
  it('matches contains', () => {
    const r = matchRules('user@corp.com', { contains: ['user@'] });
    expect(r.matched).toBe(true);
    expect(r.flags.contains).toBe(true);
  });

  it('matches endswith', () => {
    const r = matchRules('user@corp.com', { endswith: ['.com'] });
    expect(r.matched).toBe(true);
    expect(r.flags.endswith).toBe(true);
  });

  it('matches domain', () => {
    const r = matchRules('user@corp.com', { domains: ['corp.com'] });
    expect(r.matched).toBe(true);
    expect(r.flags.domain).toBe(true);
  });

  it('excludes rule overrides', () => {
    const r = matchRules('spam@corp.com', { contains: ['spam'], excludes: ['spam'] });
    expect(r.flags.excluded).toBe(true);
  });
});