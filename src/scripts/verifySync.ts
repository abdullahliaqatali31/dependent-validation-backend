import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { query } from '../db';

async function verify() {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  console.log('--- Verification Started ---');

  // 1. Get Supabase Users
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  let sbUsers: any[] = [];
  let page = 0;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error('Error fetching Supabase users:', error);
      process.exit(1);
    }
    const users = data?.users || [];
    sbUsers = sbUsers.concat(users);
    if (users.length < perPage) break;
    page++;
  }
  console.log(`Supabase Auth Users: ${sbUsers.length}`);

  // 2. Get Local Profiles
  const localProfiles = await query<{ id: string }>('SELECT id FROM profiles');
  console.log(`Local DB Profiles: ${localProfiles.rowCount}`);

  // 3. Compare IDs
  const localIds = new Set(localProfiles.rows.map(r => r.id));
  const missingFromLocal = sbUsers.filter(u => !localIds.has(u.id));

  if (missingFromLocal.length === 0) {
    console.log('✅ ALL profiles are in sync.');
  } else {
    console.log(`❌ MISMATCH: ${missingFromLocal.length} users missing in local DB.`);
    console.log('Missing IDs:', missingFromLocal.map(u => u.id).slice(0, 5).join(', '), missingFromLocal.length > 5 ? '...' : '');
    
    console.log('\nHint: Run "npm run sync:profiles" to fix this.');
  }

  process.exit(0);
}

verify().catch(e => {
  console.error('Verification failed:', e);
  process.exit(1);
});
