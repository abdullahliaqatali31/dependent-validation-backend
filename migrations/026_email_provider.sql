-- Mail-provider identity (Google Workspace / Microsoft 365 / gateway / other).
--
-- Provider is a property of the DOMAIN, so it is resolved once into domain_provider and then
-- applied to the row tables. This migration is deliberately ADD COLUMN only: migrate.ts wraps each
-- file in a single transaction, and a non-concurrent CREATE INDEX on the large row tables would
-- hold a write-blocking lock for the duration. The row indexes are created CONCURRENTLY by
-- src/scripts/backfillProvider.ts after the data is populated, which is both safe and faster.

CREATE TABLE IF NOT EXISTS domain_provider (
  domain TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'unknown',
  mx_host TEXT,
  source TEXT,
  checked_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_domain_provider_provider ON domain_provider(provider);

ALTER TABLE IF EXISTS validation_results
  ADD COLUMN IF NOT EXISTS provider TEXT;

ALTER TABLE IF EXISTS final_business_emails
  ADD COLUMN IF NOT EXISTS provider TEXT;

ALTER TABLE IF EXISTS final_personal_emails
  ADD COLUMN IF NOT EXISTS provider TEXT;

ALTER TABLE IF EXISTS free_pool
  ADD COLUMN IF NOT EXISTS provider TEXT;
