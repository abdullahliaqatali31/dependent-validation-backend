-- Ensure the handle_new_user trigger is robust and active

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_role text;
  v_email text;
  v_full_name text;
  v_avatar text;
BEGIN
  -- Try to get role from app_metadata, then user_metadata
  v_role := coalesce(new.raw_app_meta_data ->> 'role', new.raw_user_meta_data ->> 'role');
  
  v_email := new.email;
  v_full_name := coalesce(new.raw_user_meta_data ->> 'full_name',
                          new.raw_app_meta_data ->> 'full_name');
  v_avatar := coalesce(new.raw_user_meta_data ->> 'avatar_url',
                       new.raw_app_meta_data ->> 'avatar_url');

  INSERT INTO public.profiles (id, email, full_name, avatar_url, role)
  VALUES (
    new.id, 
    v_email, 
    v_full_name, 
    v_avatar, 
    coalesce(v_role, 'employee')
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    avatar_url = EXCLUDED.avatar_url,
    role = EXCLUDED.role,
    updated_at = now();

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Re-create the trigger to be sure
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Also ensure updates sync
CREATE OR REPLACE FUNCTION public.sync_user_update()
RETURNS trigger AS $$
BEGIN
  UPDATE public.profiles
  SET 
    email = new.email,
    full_name = coalesce(new.raw_user_meta_data ->> 'full_name',
                         new.raw_app_meta_data ->> 'full_name'),
    avatar_url = coalesce(new.raw_user_meta_data ->> 'avatar_url',
                          new.raw_app_meta_data ->> 'avatar_url'),
    -- Only update role if it changed in metadata, otherwise keep existing
    role = coalesce(
      new.raw_app_meta_data ->> 'role', 
      new.raw_user_meta_data ->> 'role',
      role
    ),
    updated_at = now()
  WHERE id = new.id;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
AFTER UPDATE ON auth.users
FOR EACH ROW EXECUTE PROCEDURE public.sync_user_update();
