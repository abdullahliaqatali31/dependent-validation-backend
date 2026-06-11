-- 1. free_pool.email UNIQUE constraint.
-- personalWorker.ts does `INSERT INTO free_pool(...) ON CONFLICT (email) DO NOTHING`, but no
-- matching unique constraint existed, so every collector split threw at runtime. Add it
-- (de-duping existing rows first, keeping the lowest id per email; NULL emails are left alone).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_free_pool_email'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_fp_email_dedup ON free_pool(email, id);

    -- Keep the most "important" row per email: prefer an already-assigned row, then a downloaded
    -- one, then the lowest id. Ordering by id alone could delete a row that's currently assigned to
    -- an employee, silently dropping their holding.
    CREATE TEMP TABLE temp_fp_dups AS
    SELECT id
    FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY email
        ORDER BY (is_assigned IS TRUE) DESC, (COALESCE(is_downloaded,false) IS TRUE) DESC, id ASC
      ) AS rn
      FROM free_pool
      WHERE email IS NOT NULL
    ) t
    WHERE rn > 1;

    CREATE INDEX idx_temp_fp_dups_id ON temp_fp_dups(id);

    DELETE FROM free_pool fp
    USING temp_fp_dups tmp
    WHERE fp.id = tmp.id;

    DROP TABLE IF EXISTS temp_fp_dups;
    DROP INDEX IF EXISTS idx_fp_email_dedup;

    ALTER TABLE free_pool
      ADD CONSTRAINT uq_free_pool_email UNIQUE (email);
  END IF;
END $$;

-- 2. Missing performance indexes on hot paths.
-- free_pool: every assign/summary/export query filters by assignment + download state.
CREATE INDEX IF NOT EXISTS idx_free_pool_assigned_to ON free_pool(assigned_to_uuid, is_assigned, is_downloaded);
CREATE INDEX IF NOT EXISTS idx_free_pool_take ON free_pool(category, outcome, is_assigned);

-- final_* tables are filtered by batch_id in split-stats / exports but had no index on it.
CREATE INDEX IF NOT EXISTS idx_final_business_batch ON final_business_emails(batch_id);
CREATE INDEX IF NOT EXISTS idx_final_personal_batch ON final_personal_emails(batch_id);
