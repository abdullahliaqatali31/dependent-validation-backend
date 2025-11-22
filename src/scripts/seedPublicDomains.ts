import { query } from '../db';

const COMMON_PUBLIC_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'aol.com',
  'icloud.com',
  'proton.me',
  'live.com',
  'msn.com',
  'yandex.com',
  'zoho.com',
  'mail.com'
];

async function run() {
  for (const domain of COMMON_PUBLIC_DOMAINS) {
    await query(
      'INSERT INTO public_provider_domains(domain, source, last_verified_at) VALUES ($1, $2, now()) ON CONFLICT (domain) DO NOTHING',
      [domain, 'seed']
    );
  }
  console.log(`Seeded public domains: ${COMMON_PUBLIC_DOMAINS.length}`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seeding public domains failed:', err);
    process.exit(1);
  });