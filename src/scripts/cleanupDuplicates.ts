
import { query } from '../db';

async function cleanupDuplicates() {
  console.log('Starting duplicate cleanup for filtered_emails...');
  
  try {
    // 1. Identify and delete duplicates: keeping the one with the highest ID
    // Using a subquery to find duplicates based on master_id
    const res = await query(`
      DELETE FROM filtered_emails
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY master_id ORDER BY id DESC) as r_num
          FROM filtered_emails
        ) t
        WHERE t.r_num > 1
      )
    `);
    
    console.log(`Deleted ${res.rowCount} duplicate rows from filtered_emails.`);
    
    // 2. Add UNIQUE constraint to prevent future duplicates
    try {
        await query(`ALTER TABLE filtered_emails ADD CONSTRAINT unique_master_id UNIQUE (master_id)`);
        console.log('Added UNIQUE constraint on filtered_emails(master_id).');
    } catch (e: any) {
        if (e.message.includes('already exists')) {
            console.log('Constraint unique_master_id already exists.');
        } else {
            console.error('Failed to add constraint:', e.message);
        }
    }

  } catch (e) {
    console.error('Cleanup failed:', e);
  }
  process.exit(0);
}

cleanupDuplicates();
