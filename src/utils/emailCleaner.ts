export type CleanerRules = {
  contains?: string[];
  endswith?: string[];
  domains?: string[];
  excludes?: string[];
};

const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const VALID_TLDS = ['.com', '.net', '.org', '.biz', '.us', '.ca'];
const REPAIR_SUFFIX_MAP: Record<string, string> = {
  '.c': '.com',
  '.co': '.com',
  '.cc': '.com',
  '.commom': '.com',
  '.n': '.net',
  '.ne': '.net',
  '.o': '.org',
  '.or': '.org',
  '.b': '.biz',
  '.bi': '.biz',
  '.u': '.us'
};

function stripGarbage(raw: string): string {
  let s = (raw || '').trim();
  s = s.replace(/\"|\'|<|>/g, '');
  s = s.replace(/mailto\s*:?/gi, '');
  s = s.replace(/u003/gi, '');
  s = s.replace(/\s+/g, ' ');
  s = s.trim();
  return s;
}

function applyRepairs(domain: string): { domain: string; reasons: string[] } {
  let d = domain;
  const reasons: string[] = [];
  for (const bad of Object.keys(REPAIR_SUFFIX_MAP)) {
    if (d.endsWith(bad)) {
      const good = REPAIR_SUFFIX_MAP[bad];
      d = d.slice(0, -bad.length) + good;
      reasons.push(`repaired:${bad}->${good}`);
    }
  }
  for (const tld of VALID_TLDS) {
    const m = d.match(new RegExp('(' + tld.replace('.', '\\.') + ')([a-zA-Z0-9]+)$'));
    if (m) {
      d = d.slice(0, -m[2].length);
      reasons.push(`repaired:strip-after-${tld}`);
    }
  }
  return { domain: d, reasons };
}

export function cleanEmail(raw: string, rules: CleanerRules): { cleaned: string | null; status: string; reason: string; domain: string | null } {
  const original = raw || '';
  const stripped = stripGarbage(original);
  const lc = stripped.toLowerCase();
  if (!lc.includes('@')) return { cleaned: null, status: 'removed:no_at_symbol', reason: 'no_at_symbol', domain: null };
  const parts = lc.split('@');
  const local = (parts[0] || '').trim().replace(/^\.+|\.+$/g, '');
  let domain = (parts[1] || '').trim().replace(/^\.+|\.+$/g, '');

  if (Array.isArray(rules.excludes) && rules.excludes.some(x => lc.includes(String(x).toLowerCase()))) {
    return { cleaned: null, status: 'removed:excluded', reason: 'excluded', domain: domain || null };
  }

  if (Array.isArray(rules.contains) && rules.contains.some(x => lc.includes(String(x).toLowerCase()))) {
    return { cleaned: null, status: 'removed:contains_keyword', reason: 'contains_keyword', domain: domain || null };
  }

  if (Array.isArray(rules.endswith) && rules.endswith.some(x => domain.endsWith(String(x).toLowerCase()))) {
    return { cleaned: null, status: 'removed:endswith_rule', reason: 'endswith_rule', domain: domain || null };
  }

  let repairReasons: string[] = [];
  const repaired = applyRepairs(domain);
  domain = repaired.domain;
  repairReasons = repaired.reasons;

  if (Array.isArray(rules.domains) && rules.domains.some(x => domain === String(x).toLowerCase())) {
    return { cleaned: null, status: 'removed:domain_rule', reason: 'domain_rule', domain };
  }

  const cleaned = `${local}@${domain}`;
  if (!EMAIL_REGEX.test(cleaned)) return { cleaned: null, status: 'removed:invalid_format', reason: 'invalid_format', domain };

  if (repairReasons.length > 0) {
    return { cleaned, status: 'repaired:' + repairReasons.join(','), reason: repairReasons.join(','), domain };
  }
  return { cleaned, status: 'clean', reason: 'clean', domain };
}
