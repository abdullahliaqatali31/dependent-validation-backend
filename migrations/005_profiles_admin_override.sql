-- Allow role updates from server/SQL Editor while still blocking non-admin app clients
-- Replaces public.prevent_role_change() to permit changes when no JWT is present

create or replace function public.prevent_role_change()
returns trigger as $$
declare
  v_jwt jsonb := auth.jwt();
  v_role text := coalesce(v_jwt -> 'app_metadata' ->> 'role', '');
begin
  -- Only guard when the role actually changes
  if (new.role is distinct from old.role) then
    -- If no JWT is present (typical in SQL Editor/server-side connections), permit
    if v_jwt is null then
      return new;
    end if;

    -- Otherwise require admin in the JWT
    if v_role <> 'admin' then
      raise exception 'Only admin can change role';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- No need to recreate the trigger; it will use the replaced function