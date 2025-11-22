ALTER TABLE IF EXISTS validation_results
  ADD COLUMN IF NOT EXISTS is_downloaded BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS downloaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS downloaded_batch_id BIGINT,
  ADD COLUMN IF NOT EXISTS downloaded_by UUID;

CREATE INDEX IF NOT EXISTS idx_validation_is_downloaded ON validation_results(is_downloaded);

CREATE TABLE IF NOT EXISTS download_history (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL,
  employee_uuid UUID NOT NULL,
  download_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  total_downloaded INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_download_history_batch ON download_history(batch_id);
CREATE INDEX IF NOT EXISTS idx_download_history_employee ON download_history(employee_uuid);