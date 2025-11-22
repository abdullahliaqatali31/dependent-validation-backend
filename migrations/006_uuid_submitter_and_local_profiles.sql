-- Migrate identity to Supabase UUIDs and add a local profiles table

-- 1) Add submitter_uuid to batches and master_emails
ALTER TABLE IF EXISTS batches
  ADD COLUMN IF NOT EXISTS submitter_uuid UUID;

ALTER TABLE IF EXISTS master_emails
  ADD COLUMN IF NOT EXISTS submitter_uuid UUID;

-- Helpful indexes for lookups
CREATE INDEX IF NOT EXISTS idx_batches_submitter_uuid ON batches(submitter_uuid);
CREATE INDEX IF NOT EXISTS idx_master_submitter_uuid ON master_emails(submitter_uuid);

-- 2) Create a local profiles table (if not present)
-- This mirrors the Supabase profiles shape but is populated via sync script
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  team_id BIGINT,
  role TEXT CHECK (role IN ('admin','collector','employee')) DEFAULT 'employee',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Updated_at helper trigger (no-op if function exists)
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at'
  ) THEN
    CREATE OR REPLACE FUNCTION public.set_updated_at()
    RETURNS trigger AS $func$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;
  END IF;
END;
$do$;

DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();