ALTER TABLE IF EXISTS validation_results
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS is_personal BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_business BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS final_business_emails (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT REFERENCES batches(batch_id) ON DELETE CASCADE,
  master_id BIGINT REFERENCES master_emails(id) ON DELETE CASCADE,
  email TEXT,
  domain TEXT,
  outcome TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS final_personal_emails (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT REFERENCES batches(batch_id) ON DELETE CASCADE,
  master_id BIGINT REFERENCES master_emails(id) ON DELETE CASCADE,
  email TEXT,
  domain TEXT,
  outcome TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_final_business_batch ON final_business_emails(batch_id);
CREATE INDEX IF NOT EXISTS idx_final_personal_batch ON final_personal_emails(batch_id);
