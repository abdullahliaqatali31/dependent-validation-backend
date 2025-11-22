import fs from 'fs';
import path from 'path';
import { query } from '../db';

function pyList(name: string, items: string[]): string {
  const body = items.map(x => `'${x.replace(/'/g, "\\'")}'`).join(',');
  return `${name} = {${body}}`;
}

async function run() {
  const rows = await query<any>(`SELECT contains, endswith, domains FROM rules`);
  const contains = new Set<string>();
  const endswith = new Set<string>();
  const domains = new Set<string>();
  for (const r of rows.rows) {
    (Array.isArray(r.contains) ? r.contains : []).forEach((x: string) => contains.add(String(x).toLowerCase()));
    (Array.isArray(r.endswith) ? r.endswith : []).forEach((x: string) => endswith.add(String(x).toLowerCase()));
    (Array.isArray(r.domains) ? r.domains : []).forEach((x: string) => domains.add(String(x).toLowerCase()));
  }
  const personalRows = await query<any>(`SELECT domain FROM public_provider_domains`);
  const personal = personalRows.rows.map((r: any) => String(r.domain).toLowerCase());

  const REPAIR_SUFFIX_MAP: Record<string, string> = {
    '.c': '.com', '.co': '.com', '.cc': '.com', '.commom': '.com',
    '.n': '.net', '.ne': '.net', '.o': '.org', '.or': '.org',
    '.b': '.biz', '.bi': '.biz', '.u': '.us'
  };
  const VALID_TLDS = ['.com', '.net', '.org', '.biz', '.us', '.ca'];

  const lines = [
    'CONTAINS_KEYWORDS = ' + `{${Array.from(contains).map(x => `'${x}'`).join(',')}}`,
    'ENDWITH_DELETE = ' + `{${Array.from(endswith).map(x => `'${x}'`).join(',')}}`,
    'REPAIR_SUFFIX_MAP = ' + `{${Object.entries(REPAIR_SUFFIX_MAP).map(([k,v]) => `'${k}': '${v}'`).join(',')}}`,
    'VALID_TLDS = ' + `{${VALID_TLDS.map(x => `'${x}'`).join(',')}}`,
    'PERSONAL_DOMAINS = ' + `{${personal.map(x => `'${x}'`).join(',')}}`
  ];

  const content = lines.join('\n') + '\n';
  const outPath = path.join(process.cwd(), 'python_email_rules.py');
  fs.writeFileSync(outPath, content, 'utf8');
  console.log('Written', outPath);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });

