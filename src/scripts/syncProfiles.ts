import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { query } from '../db';

async function run() {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in backend/.env');
    process.exit(1);
  }
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  let page = 0;
  const perPage = 1000;
  let total = 0;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    for (const u of users) {
      const id = u.id as string;
      const email = u.email as string | null;
      const role = (u.app_metadata?.role || u.user_metadata?.role || 'employee') as string;
      const full_name = (u.user_metadata?.full_name || u.app_metadata?.full_name || null) as string | null;
      const avatar_url = (u.user_metadata?.avatar_url || u.app_metadata?.avatar_url || null) as string | null;
      await query(
        `INSERT INTO profiles(id, email, full_name, avatar_url, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           full_name = EXCLUDED.full_name,
           avatar_url = EXCLUDED.avatar_url,
           role = EXCLUDED.role,
           updated_at = now()`,
        [id, email, full_name, avatar_url, role]
      );
      total++;
    }
    if (users.length < perPage) break;
    page++;
  }
  console.log(`Synced ${total} profiles`);
  process.exit(0);
}

run().catch((e) => {
  console.error('syncProfiles failed:', e);
  process.exit(1);
});