-- Extend validation_results with Ninja metadata and reason/message fields
ALTER TABLE IF EXISTS validation_results
  ADD COLUMN IF NOT EXISTS domain TEXT,
  ADD COLUMN IF NOT EXISTS mx TEXT,
  ADD COLUMN IF NOT EXISTS message TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB;