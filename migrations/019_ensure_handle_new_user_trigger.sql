-- Migration 019: Re-ensure the handle_new_user trigger is active on the live DB.
-- This is idempotent — safe to run even if already applied.
-- The trigger auto-creates a profiles row whenever a new auth.users row is inserted,
-- acting as a second safety net alongside the explicit upsert in POST /admin/users.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.sync_user_update();
