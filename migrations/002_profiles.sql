-- Supabase Profiles table with triggers to sync from auth.users
-- and Row Level Security policies for role-based access.

-- 1) Profiles table (server-trusted profile state)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  team_id bigint,
  role text check (role in ('admin','collector','employee')) default 'employee',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2) Updated_at trigger
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

-- 3) Create profile on new user
create or replace function public.handle_new_user()
returns trigger as $$
declare
  v_role text;
  v_email text;
  v_full_name text;
  v_avatar text;
begin
  v_role := new.raw_app_meta_data ->> 'role';
  v_email := new.email;
  v_full_name := coalesce(new.raw_user_meta_data ->> 'full_name',
                          new.raw_app_meta_data ->> 'full_name');
  v_avatar := coalesce(new.raw_user_meta_data ->> 'avatar_url',
                       new.raw_app_meta_data ->> 'avatar_url');

  insert into public.profiles (id, email, full_name, avatar_url, role)
  values (new.id, v_email, v_full_name, v_avatar, coalesce(v_role, 'employee'));

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- 4) Keep profile in sync when auth.users updates
create or replace function public.sync_user_update()
returns trigger as $$
begin
  update public.profiles
  set email = new.email,
      full_name = coalesce(new.raw_user_meta_data ->> 'full_name',
                           new.raw_app_meta_data ->> 'full_name'),
      avatar_url = coalesce(new.raw_user_meta_data ->> 'avatar_url',
                            new.raw_app_meta_data ->> 'avatar_url'),
      role = coalesce(new.raw_app_meta_data ->> 'role', role)
  where id = new.id;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
after update on auth.users
for each row execute procedure public.sync_user_update();

-- 5) Prevent non-admin role changes
create or replace function public.prevent_role_change()
returns trigger as $$
declare
  jwt_role text := auth.jwt() -> 'app_metadata' ->> 'role';
begin
  if (new.role is distinct from old.role)
     and (coalesce(jwt_role, '') <> 'admin') then
    raise exception 'Only admin can change role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists profiles_prevent_role_change on public.profiles;
create trigger profiles_prevent_role_change
before update on public.profiles
for each row execute procedure public.prevent_role_change();

-- 6) Enable RLS
alter table public.profiles enable row level security;

-- 7) Read: user can read own profile, admin can read all
drop policy if exists select_own_or_admin on public.profiles;
create policy select_own_or_admin
on public.profiles for select
to authenticated
using (
  id = auth.uid() or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- 8) Update: user can update own non-sensitive fields; admin can update all
drop policy if exists update_own on public.profiles;
create policy update_own
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists update_admin on public.profiles;
create policy update_admin
on public.profiles for update
to authenticated
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 9) Insert: block direct inserts (created via trigger), allow admin if needed
drop policy if exists insert_admin on public.profiles;
create policy insert_admin
on public.profiles for insert
to authenticated
with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 10) Delete: admin only
drop policy if exists delete_admin on public.profiles;
create policy delete_admin
on public.profiles for delete
to authenticated
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');