import { query } from '../db';
import { DEFAULT_PUBLIC_DOMAINS } from '../workers/common';

async function run() {
  console.log('Starting migration of misclassified personal emails...');

  // 1. Ensure all default public domains are in the database table
  console.log('Seeding default public domains to database...');
  for (const domain of DEFAULT_PUBLIC_DOMAINS) {
    await query(
      'INSERT INTO public_provider_domains(domain, source, last_verified_at) VALUES ($1, $2, now()) ON CONFLICT (domain) DO NOTHING',
      [domain, 'seed_fix']
    );
  }

  // 2. Identify and move emails from final_business_emails to final_personal_emails
  console.log('Moving emails from final_business_emails to final_personal_emails...');
  
  // We use a transaction to ensure data integrity
  const client = await query('BEGIN');
  
  try {
    // A. Move data
    const moveResult = await query(`
      INSERT INTO final_personal_emails (batch_id, master_id, email, domain, outcome, is_free_pool, created_at)
      SELECT fbe.batch_id, fbe.master_id, fbe.email, fbe.domain, fbe.outcome, fbe.is_free_pool, fbe.created_at
      FROM final_business_emails fbe
      JOIN public_provider_domains ppd ON LOWER(fbe.domain) = LOWER(ppd.domain)
      ON CONFLICT (master_id) DO NOTHING
    `);
    console.log(`Inserted ${moveResult.rowCount} rows into final_personal_emails.`);

    // B. Delete from business
    const deleteResult = await query(`
      DELETE FROM final_business_emails
      WHERE domain IN (SELECT domain FROM public_provider_domains)
    `);
    console.log(`Deleted ${deleteResult.rowCount} rows from final_business_emails.`);

    // C. Update validation_results for consistency
    const updateValidationResult = await query(`
      UPDATE validation_results
      SET category = 'personal', is_personal = true, is_business = false
      WHERE domain IN (SELECT domain FROM public_provider_domains)
      AND (category != 'personal' OR is_personal = false)
    `);
    console.log(`Updated ${updateValidationResult.rowCount} rows in validation_results.`);

    // D. Update free_pool for consistency
    const updateFreePoolResult = await query(`
      UPDATE free_pool
      SET category = 'personal'
      WHERE domain IN (SELECT domain FROM public_provider_domains)
      AND category != 'personal'
    `);
    console.log(`Updated ${updateFreePoolResult.rowCount} rows in free_pool.`);

    await query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (err) {
    await query('ROLLBACK');
    console.error('Migration failed, rolled back changes:', err);
    process.exit(1);
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Script error:', err);
    process.exit(1);
  });
