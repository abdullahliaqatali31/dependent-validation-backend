-- Add unique constraint to filtered_emails.master_id
-- Required for ON CONFLICT (master_id) DO NOTHING in filterWorker
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_filtered_emails_master_id'
  ) THEN
    DELETE FROM filtered_emails
    WHERE id NOT IN (
      SELECT MIN(id) FROM filtered_emails GROUP BY master_id
    );
    ALTER TABLE filtered_emails
      ADD CONSTRAINT uq_filtered_emails_master_id UNIQUE (master_id);
  END IF;
END $$;

-- Add unique constraint to validation_results.master_id
-- Required for ON CONFLICT (master_id) DO NOTHING in validationMulti
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_validation_results_master_id'
  ) THEN
    DELETE FROM validation_results
    WHERE id NOT IN (
      SELECT MIN(id) FROM validation_results GROUP BY master_id
    );
    ALTER TABLE validation_results
      ADD CONSTRAINT uq_validation_results_master_id UNIQUE (master_id);
  END IF;
END $$;
