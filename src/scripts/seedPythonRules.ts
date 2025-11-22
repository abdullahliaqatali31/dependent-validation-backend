import { query } from '../db';

const CONTAINS = [
  'k12','noreply','automation','trashmail.com','postmaster',
  'toyota','navy','transportation','publish','fruit','motor','medicine','pharmacy',
  'dubai','qatar','fedex.com','army','lawoffice','lawgroup','lawfirm','law.',
  'advocate','domain','example','wixpress','apple.com','software','microsoft',
  'food','restaurant','.edu','education','edu','schedule','telecom','movie',
  'truck','transport','medical','spam','police','fertilize','insurance','news.',
  'news','media','bank','health','insure','traveler','solar','godaddy','learn',
  'comcast','law@','sbcglobal','rediffmail.com','lawyers','video','@procore'
];

const ENDSWITH = [
  '.gov', '.lawyer', '.edu', '.tv', '.in', '.pk', '.za', '.go', '.d', '.ar',
  '.ae', '.rr', '.cn', '.nz', '.jp', '.nl', '.mil', '.de', '.ie', '.fr', '.hk',
  '.se', '.id', '.cz', '.io', '.lb', '.fi', '.tc', '.dk', '.th', '.lt', '.no',
  '.law', '.fm'
];

async function run() {
  const existing = await query<any>(
    `SELECT id, scope, contains, endswith, domains, excludes, priority FROM rules WHERE scope='global' ORDER BY updated_at DESC LIMIT 1`
  );
  let id: number | null = existing.rows[0]?.id ?? null;
  const prevContains: string[] = Array.isArray(existing.rows[0]?.contains) ? existing.rows[0].contains : [];
  const prevEndswith: string[] = Array.isArray(existing.rows[0]?.endswith) ? existing.rows[0].endswith : [];
  const prevDomains: string[] = Array.isArray(existing.rows[0]?.domains) ? existing.rows[0].domains : [];
  const prevExcludes: string[] = Array.isArray(existing.rows[0]?.excludes) ? existing.rows[0].excludes : [];

  const set = (list: string[]) => Array.from(new Set(list.map(x => String(x).toLowerCase())));
  const mergedContains = set([...prevContains, ...CONTAINS]);
  const mergedEndswith = set([...prevEndswith, ...ENDSWITH]);
  const mergedDomains = set([...prevDomains]);
  const mergedExcludes = set([...prevExcludes]);

  if (id) {
    await query(
      `UPDATE rules SET contains=$2, endswith=$3, domains=$4, excludes=$5, updated_at=now() WHERE id=$1`,
      [id, JSON.stringify(mergedContains), JSON.stringify(mergedEndswith), JSON.stringify(mergedDomains), JSON.stringify(mergedExcludes)]
    );
  } else {
    const row = await query(
      `INSERT INTO rules(scope, contains, endswith, domains, excludes, priority) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      ['global', JSON.stringify(mergedContains), JSON.stringify(mergedEndswith), JSON.stringify(mergedDomains), JSON.stringify(mergedExcludes), 100]
    );
    id = row.rows[0]?.id ?? null;
  }
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });

