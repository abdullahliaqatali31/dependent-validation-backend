-- Core schema for CSI Centralized Email Management System

CREATE TABLE IF NOT EXISTS batches (
  batch_id BIGSERIAL PRIMARY KEY,
  submitter_id BIGINT NOT NULL,
  submitter_team_id BIGINT,
  file_path TEXT,
  total_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'created',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Staging table for raw uploads
CREATE TABLE IF NOT EXISTS master_emails_temp (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
  email_raw TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS master_emails (
  id BIGSERIAL PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  email_raw TEXT,
  domain TEXT,
  local_part TEXT,
  submitter_id BIGINT,
  submitter_team_id BIGINT,
  batch_id BIGINT REFERENCES batches(batch_id) ON DELETE SET NULL,
  dedupe_status TEXT DEFAULT 'unique',
  first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_master_email_norm ON master_emails(email_normalized);
CREATE INDEX IF NOT EXISTS idx_master_email_norm ON master_emails(email_normalized);

CREATE TABLE IF NOT EXISTS filter_emails (
  id BIGSERIAL PRIMARY KEY,
  master_id BIGINT REFERENCES master_emails(id) ON DELETE CASCADE,
  filter_flags JSONB,
  matched_keyword TEXT,
  matched_domain TEXT,
  filtered_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS personal_emails (
  id BIGSERIAL PRIMARY KEY,
  master_id BIGINT REFERENCES master_emails(id) ON DELETE CASCADE,
  domain TEXT,
  assigned_flag BOOLEAN DEFAULT FALSE,
  assigned_employee_id BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS validation_results (
  id BIGSERIAL PRIMARY KEY,
  master_id BIGINT REFERENCES master_emails(id) ON DELETE CASCADE,
  status_enum TEXT,
  details JSONB,
  ninja_key_used TEXT,
  validated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_master ON validation_results(master_id);

CREATE TABLE IF NOT EXISTS unsubscribe_list (
  email TEXT PRIMARY KEY,
  added_by BIGINT,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unsubscribe_domains (
  domain TEXT PRIMARY KEY,
  added_by BIGINT,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS free_pool (
  id BIGSERIAL PRIMARY KEY,
  master_id BIGINT REFERENCES master_emails(id) ON DELETE CASCADE,
  available BOOLEAN DEFAULT TRUE,
  assigned_to BIGINT,
  assigned_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS rules (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT DEFAULT 'employee', -- employee | team | global
  employee_id BIGINT,
  team_id BIGINT,
  contains JSONB,
  endswith JSONB,
  domains JSONB,
  priority INTEGER DEFAULT 0,
  excludes JSONB,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public_provider_domains (
  domain TEXT PRIMARY KEY,
  source TEXT,
  last_verified_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  action_type TEXT,
  actor_id BIGINT,
  resource_ref TEXT,
  details JSONB,
  trace_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);