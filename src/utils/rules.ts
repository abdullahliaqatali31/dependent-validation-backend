export type RuleSet = {
  contains?: string[];
  endswith?: string[];
  domains?: string[];
  excludes?: string[];
};

export function matchRules(email: string, rules: RuleSet) {
  const lc = email.toLowerCase();
  const domain = lc.split('@')[1] || '';
  const flags: Record<string, boolean> = {};

  let matchedKeyword: string | null = null;
  let matchedDomain: string | null = null;

  if (rules.excludes && rules.excludes.some(x => lc.includes(x.toLowerCase()))) {
    flags.excluded = true;
  }

  if (rules.contains) {
    for (const c of rules.contains) {
      if (lc.includes(c.toLowerCase())) {
        flags.contains = true;
        matchedKeyword = c;
        break;
      }
    }
  }

  if (rules.endswith) {
    for (const e of rules.endswith) {
      if (lc.endsWith(e.toLowerCase())) {
        flags.endswith = true;
        matchedKeyword = e;
        break;
      }
    }
  }

  if (rules.domains) {
    for (const d of rules.domains) {
      if (domain === d.toLowerCase()) {
        flags.domain = true;
        matchedDomain = d;
        break;
      }
    }
  }

  const matched = !!(flags.contains || flags.endswith || flags.domain);
  return { matched, flags, matchedKeyword, matchedDomain };
}