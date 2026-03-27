-- Migration 019: Re-ensure the handle_new_user trigger is active on the live DB.
-- NOTE: This migration is skipped by backend/src/migrate.ts if the 'auth' schema 
-- is not found (common in local Postgres or secondary app servers).
-- It is primarily intended for the primary Supabase database.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.sync_user_update();
