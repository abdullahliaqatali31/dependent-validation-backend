ALTER TABLE IF EXISTS free_pool
  ADD COLUMN IF NOT EXISTS assigned_to_uuid UUID;

CREATE INDEX IF NOT EXISTS idx_free_pool_assigned_to_uuid ON free_pool(assigned_to_uuid);

