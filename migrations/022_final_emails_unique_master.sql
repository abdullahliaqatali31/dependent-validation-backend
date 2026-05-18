-- Step 1: Create plain indexes first so the dedup DELETE can use them (critical on large tables)
CREATE INDEX IF NOT EXISTS idx_fbe_master_id_dedup ON final_business_emails(master_id);
CREATE INDEX IF NOT EXISTS idx_fpe_master_id_dedup ON final_personal_emails(master_id);

-- Step 2: Remove duplicate rows using a self-join (fast with the index above)
DELETE FROM final_business_emails a
USING final_business_emails b
WHERE a.master_id = b.master_id AND a.id > b.id;

DELETE FROM final_personal_emails a
USING final_personal_emails b
WHERE a.master_id = b.master_id AND a.id > b.id;

-- Step 3: Add unique constraints (idempotent — safe to re-run)
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

-- Step 4: Drop the plain dedup indexes — the UNIQUE constraints above replaced them with unique indexes
DROP INDEX IF EXISTS idx_fbe_master_id_dedup;
DROP INDEX IF EXISTS idx_fpe_master_id_dedup;
