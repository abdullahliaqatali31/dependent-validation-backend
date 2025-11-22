import { query } from '../db';
import { config } from '../config';

async function main() {
  const arg = process.argv[2];
  const batchId = Number(arg || process.env.BATCH_ID || 1);
  const rows = await query<{ email: string; status: string; message: string | null; domain: string | null; mx: string | null }>(
    `SELECT me.email_normalized AS email,
            vr.status_enum AS status,
            vr.message AS message,
            vr.domain AS domain,
            vr.mx AS mx
     FROM validation_results vr
     JOIN master_emails me ON vr.master_id = me.id
     WHERE me.batch_id = $1
     ORDER BY vr.validated_at DESC`,
    [batchId]
  );
  console.log('DB:', config.databaseUrl);
  console.table(rows.rows);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});