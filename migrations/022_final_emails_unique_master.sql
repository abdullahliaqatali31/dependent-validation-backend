-- Remove duplicate rows (keep the lowest id per master_id) before adding constraint
DELETE FROM final_business_emails
WHERE id NOT IN (
  SELECT MIN(id) FROM final_business_emails GROUP BY master_id
);

DELETE FROM final_personal_emails
WHERE id NOT IN (
  SELECT MIN(id) FROM final_personal_emails GROUP BY master_id
);

-- Unique constraint: each master email can only appear once in each final table
-- Wrapped in idempotent DO blocks so re-running the migration does not crash
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

-- Index to speed up the queueWatcher stuck-split query
CREATE INDEX IF NOT EXISTS idx_final_business_master ON final_business_emails(master_id);
CREATE INDEX IF NOT EXISTS idx_final_personal_master ON final_personal_emails(master_id);
