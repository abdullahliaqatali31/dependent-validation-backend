-- Step 1: Create compound indexes to enable Index-Only Scans for the window partition (critical on large tables)
CREATE INDEX IF NOT EXISTS idx_fbe_master_id_dedup ON final_business_emails(master_id, id);
CREATE INDEX IF NOT EXISTS idx_fpe_master_id_dedup ON final_personal_emails(master_id, id);

-- Step 2: Extract duplicate IDs into Temporary Tables (extremely fast, bypasses WAL logs)
CREATE TEMP TABLE temp_fbe_dups AS
SELECT id
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY master_id ORDER BY id) as rn
  FROM final_business_emails
) t
WHERE rn > 1;

CREATE INDEX idx_temp_fbe_dups_id ON temp_fbe_dups(id);

CREATE TEMP TABLE temp_fpe_dups AS
SELECT id
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY master_id ORDER BY id) as rn
  FROM final_personal_emails
) t
WHERE rn > 1;

CREATE INDEX idx_temp_fpe_dups_id ON temp_fpe_dups(id);

-- Step 3: Delete using an optimized Primary Key Join
DELETE FROM final_business_emails fbe
USING temp_fbe_dups tmp
WHERE fbe.id = tmp.id;

DELETE FROM final_personal_emails fpe
USING temp_fpe_dups tmp
WHERE fpe.id = tmp.id;

-- Step 4: Drop temporary tables
DROP TABLE IF EXISTS temp_fbe_dups;
DROP TABLE IF EXISTS temp_fpe_dups;

-- Step 5: Add unique constraints (idempotent — safe to re-run)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_final_business_master_id'
  ) THEN
    ALTER TABLE final_business_emails
      ADD CONSTRAINT uq_final_business_master_id UNIQUE (master_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_final_personal_master_id'
  ) THEN
    ALTER TABLE final_personal_emails
      ADD CONSTRAINT uq_final_personal_master_id UNIQUE (master_id);
  END IF;
END $$;

-- Step 6: Drop the plain dedup indexes — the UNIQUE constraints above automatically create unique indexes
DROP INDEX IF EXISTS idx_fbe_master_id_dedup;
DROP INDEX IF EXISTS idx_fpe_master_id_dedup;
