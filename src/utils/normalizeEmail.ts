export type NormalizationStrategy = 'none' | 'gmail_dot_strip' | 'plus_tag_strip' | 'gmail_full';

export function normalizeEmail(raw: string, strategy: NormalizationStrategy = 'none') {
  const trimmed = raw.trim().toLowerCase();
  const [local, domain] = trimmed.split('@');
  if (!domain || !local) return { normalized: trimmed, local, domain, strategy: 'none' as NormalizationStrategy };

  let normLocal = local;
  if (strategy === 'gmail_dot_strip' || strategy === 'gmail_full') {
    if (domain === 'gmail.com') {
      normLocal = normLocal.replace(/\./g, '');
    }
  }
  if (strategy === 'plus_tag_strip' || strategy === 'gmail_full') {
    normLocal = normLocal.split('+')[0];
  }
  return { normalized: `${normLocal}@${domain}`, local: normLocal, domain, strategy };
}