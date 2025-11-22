-- Backfill existing auth.users into public.profiles
-- Run this once after creating the profiles table to populate rows
-- for users that existed before the trigger was added.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL AND to_regclass('auth.users') IS NOT NULL THEN
    -- Insert any missing profiles for existing auth users
    INSERT INTO public.profiles (id, email, full_name, avatar_url, role)
    SELECT
      u.id,
      u.email,
      COALESCE(u.raw_user_meta_data ->> 'full_name',
               u.raw_app_meta_data ->> 'full_name') AS full_name,
      COALESCE(u.raw_user_meta_data ->> 'avatar_url',
               u.raw_app_meta_data ->> 'avatar_url') AS avatar_url,
      COALESCE(u.raw_app_meta_data ->> 'role', 'employee') AS role
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    WHERE p.id IS NULL;

    -- Optionally sync fields for already-present profiles to match current auth.users
    UPDATE public.profiles p
    SET
      email = u.email,
      full_name = COALESCE(u.raw_user_meta_data ->> 'full_name',
                           u.raw_app_meta_data ->> 'full_name'),
      avatar_url = COALESCE(u.raw_user_meta_data ->> 'avatar_url',
                            u.raw_app_meta_data ->> 'avatar_url'),
      role = COALESCE(u.raw_app_meta_data ->> 'role', p.role),
      updated_at = NOW()
    FROM auth.users u
    WHERE p.id = u.id;
  END IF;
END $$;