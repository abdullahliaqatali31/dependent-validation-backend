-- Add download tracking columns to free_pool table
ALTER TABLE IF EXISTS free_pool
  ADD COLUMN IF NOT EXISTS is_downloaded BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS downloaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS downloaded_by UUID;

CREATE INDEX IF NOT EXISTS idx_free_pool_is_downloaded ON free_pool(is_downloaded);
