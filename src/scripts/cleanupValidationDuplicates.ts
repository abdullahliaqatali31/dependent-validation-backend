
import { query } from '../db';

async function cleanupValidationDuplicates() {
  console.log('Starting duplicate cleanup for validation_results...');
  
  try {
    // 1. Identify and delete duplicates: keeping the one with the highest ID
    // Using a subquery to find duplicates based on master_id
    const res = await query(`
      DELETE FROM validation_results
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY master_id ORDER BY id DESC) as r_num
          FROM validation_results
        ) t
        WHERE t.r_num > 1
      )
    `);
    
    console.log(`Deleted ${res.rowCount} duplicate rows from validation_results.`);
    
    // 2. Add UNIQUE constraint to prevent future duplicates
    try {
        await query(`ALTER TABLE validation_results ADD CONSTRAINT unique_val_master_id UNIQUE (master_id)`);
        console.log('Added UNIQUE constraint on validation_results(master_id).');
    } catch (e: any) {
        if (e.message.includes('already exists')) {
            console.log('Constraint unique_val_master_id already exists.');
        } else {
            console.error('Failed to add constraint:', e.message);
        }
    }

  } catch (e) {
    console.error('Cleanup failed:', e);
  }
  process.exit(0);
}

cleanupValidationDuplicates();
