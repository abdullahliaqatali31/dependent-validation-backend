ALTER TABLE IF EXISTS free_pool
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS domain TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS is_assigned BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS assigned_to UUID,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_free_pool BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES batches(batch_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_free_pool_assigned ON free_pool(is_assigned);
CREATE INDEX IF NOT EXISTS idx_free_pool_category ON free_pool(category);
CREATE INDEX IF NOT EXISTS idx_free_pool_batch ON free_pool(batch_id);

CREATE TABLE IF NOT EXISTS system_settings (
  id BIGSERIAL PRIMARY KEY,
  daily_free_pool_limit INT DEFAULT 200,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE IF EXISTS final_business_emails
  ADD COLUMN IF NOT EXISTS is_free_pool BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS assigned_from_free_pool BOOLEAN DEFAULT false;

ALTER TABLE IF EXISTS final_personal_emails
  ADD COLUMN IF NOT EXISTS is_free_pool BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS assigned_from_free_pool BOOLEAN DEFAULT false;
