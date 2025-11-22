-- Add optional details and UUID tracking for employee-specific unsubscribes
ALTER TABLE IF EXISTS unsubscribe_list
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS campaign TEXT,
  ADD COLUMN IF NOT EXISTS added_by_uuid TEXT;

ALTER TABLE IF EXISTS unsubscribe_domains
  ADD COLUMN IF NOT EXISTS added_by_uuid TEXT;

-- Audit table to preserve per-employee history without affecting global filtering
CREATE TABLE IF NOT EXISTS unsubscribe_actions (
  id BIGSERIAL PRIMARY KEY,
  email TEXT,
  domain TEXT,
  employee_uuid TEXT,
  reason TEXT,
  campaign TEXT,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);