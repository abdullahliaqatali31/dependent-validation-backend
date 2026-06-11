export type NormalizationStrategy = 'none' | 'gmail_dot_strip' | 'plus_tag_strip' | 'gmail_full';

export function normalizeEmail(raw: string, strategy: NormalizationStrategy = 'none') {
  let decoded = (raw || '').trim();
  try { decoded = decodeURIComponent(decoded); } catch { /* malformed encoding — leave as-is */ }
  // Remove ALL whitespace: decoding "%20" produces a real space that must not survive
  // into email_normalized, or it re-encodes back to "%20" in URLs/exports.
  decoded = decoded.replace(/\s+/g, '');
  const trimmed = decoded.toLowerCase();
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