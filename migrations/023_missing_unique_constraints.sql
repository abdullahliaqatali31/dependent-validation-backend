-- Add unique constraint to filtered_emails.master_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_filtered_emails_master_id'
  ) THEN
    -- 1. Create temporary index to speed up duplicates search
    CREATE INDEX IF NOT EXISTS idx_fe_master_id_dedup ON filtered_emails(master_id, id);
    
    -- 2. Extract duplicate IDs to Temp Table
    CREATE TEMP TABLE temp_fe_dups AS
    SELECT id
    FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY master_id ORDER BY id) as rn
      FROM filtered_emails
    ) t
    WHERE rn > 1;
    
    CREATE INDEX idx_temp_fe_dups_id ON temp_fe_dups(id);
    
    -- 3. Delete duplicates
    DELETE FROM filtered_emails fe
    USING temp_fe_dups tmp
    WHERE fe.id = tmp.id;
    
    -- 4. Clean up temp structures
    DROP TABLE IF EXISTS temp_fe_dups;
    DROP INDEX IF EXISTS idx_fe_master_id_dedup;

    -- 5. Add constraint
    ALTER TABLE filtered_emails
      ADD CONSTRAINT uq_filtered_emails_master_id UNIQUE (master_id);
  END IF;
END $$;

-- Add unique constraint to validation_results.master_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_validation_results_master_id'
  ) THEN
    -- 1. Create temporary index to speed up duplicates search
    CREATE INDEX IF NOT EXISTS idx_vr_master_id_dedup ON validation_results(master_id, id);
    
    -- 2. Extract duplicate IDs to Temp Table
    CREATE TEMP TABLE temp_vr_dups AS
    SELECT id
    FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY master_id ORDER BY id) as rn
      FROM validation_results
    ) t
    WHERE rn > 1;
    
    CREATE INDEX idx_temp_vr_dups_id ON temp_vr_dups(id);
    
    -- 3. Delete duplicates
    DELETE FROM validation_results vr
    USING temp_vr_dups tmp
    WHERE vr.id = tmp.id;
    
    -- 4. Clean up temp structures
    DROP TABLE IF EXISTS temp_vr_dups;
    DROP INDEX IF EXISTS idx_vr_master_id_dedup;

    -- 5. Add constraint
    ALTER TABLE validation_results
      ADD CONSTRAINT uq_validation_results_master_id UNIQUE (master_id);
  END IF;
END $$;
