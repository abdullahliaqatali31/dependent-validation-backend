CREATE TABLE IF NOT EXISTS ninja_keys (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  last_used_at TIMESTAMPTZ,
  total_requests BIGINT DEFAULT 0,
  total_success BIGINT DEFAULT 0,
  total_failed BIGINT DEFAULT 0,
  consecutive_errors INT DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ninja_keys_key ON ninja_keys(key);

