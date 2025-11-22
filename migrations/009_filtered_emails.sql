CREATE TABLE IF NOT EXISTS filtered_emails (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT REFERENCES batches(batch_id) ON DELETE CASCADE,
  master_id BIGINT REFERENCES master_emails(id) ON DELETE CASCADE,
  original_email TEXT,
  cleaned_email TEXT,
  status TEXT,
  reason TEXT,
  domain TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_filtered_emails_batch ON filtered_emails(batch_id);
CREATE INDEX IF NOT EXISTS idx_filtered_emails_master ON filtered_emails(master_id);
CREATE INDEX IF NOT EXISTS idx_filtered_emails_status ON filtered_emails(status);
CREATE INDEX IF NOT EXISTS idx_filtered_emails_domain ON filtered_emails(domain);

