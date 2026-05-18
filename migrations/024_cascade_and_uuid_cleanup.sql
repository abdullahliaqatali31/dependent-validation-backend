-- MED-06: Change master_emails.batch_id from ON DELETE SET NULL to ON DELETE CASCADE
-- Orphaned master_emails (batch_id = NULL after batch delete) pollute deduplication and
-- the bloom filter — a deleted batch's emails should be removed entirely.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'master_emails_batch_id_fkey'
  ) THEN
    ALTER TABLE master_emails DROP CONSTRAINT master_emails_batch_id_fkey;
  END IF;
END $$;

ALTER TABLE master_emails
  ALTER COLUMN batch_id DROP NOT NULL;

ALTER TABLE master_emails
  ADD CONSTRAINT master_emails_batch_id_fkey
  FOREIGN KEY (batch_id) REFERENCES batches(batch_id) ON DELETE CASCADE;

-- MED-20: Normalize employee_uuid columns to UUID type where they were left as TEXT
-- unsubscribe_actions.employee_uuid
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='unsubscribe_actions' AND column_name='employee_uuid' AND data_type='text'
  ) THEN
    -- Remove rows with invalid UUIDs before altering
    DELETE FROM unsubscribe_actions
    WHERE employee_uuid IS NOT NULL
      AND employee_uuid !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    ALTER TABLE unsubscribe_actions
      ALTER COLUMN employee_uuid TYPE UUID USING employee_uuid::UUID;
  END IF;
END $$;

-- unsubscribe_list.added_by_uuid
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='unsubscribe_list' AND column_name='added_by_uuid' AND data_type='text'
  ) THEN
    DELETE FROM unsubscribe_list
    WHERE added_by_uuid IS NOT NULL
      AND added_by_uuid !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    ALTER TABLE unsubscribe_list
      ALTER COLUMN added_by_uuid TYPE UUID USING added_by_uuid::UUID;
  END IF;
END $$;

-- unsubscribe_domains.added_by_uuid
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='unsubscribe_domains' AND column_name='added_by_uuid' AND data_type='text'
  ) THEN
    DELETE FROM unsubscribe_domains
    WHERE added_by_uuid IS NOT NULL
      AND added_by_uuid !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    ALTER TABLE unsubscribe_domains
      ALTER COLUMN added_by_uuid TYPE UUID USING added_by_uuid::UUID;
  END IF;
END $$;
