import { normalizeEmail } from '../src/utils/normalizeEmail';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    const r = normalizeEmail('  Foo@EXAMPLE.com  ');
    expect(r.normalized).toBe('foo@example.com');
  });

  it('gmail dot stripping when strategy enabled', () => {
    const r = normalizeEmail('f.o.o@gmail.com', 'gmail_dot_strip');
    expect(r.normalized).toBe('foo@gmail.com');
  });

  it('plus tag removal', () => {
    const r = normalizeEmail('foo+bar@example.com', 'plus_tag_strip');
    expect(r.normalized).toBe('foo@example.com');
  });
});