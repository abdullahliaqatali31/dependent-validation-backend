-- Helper functions and role-based policies for core tables
-- Roles: admin, collector, employee

-- 1) Helper: check the current JWT role
create or replace function public.jwt_role()
returns text as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')::text;
$$ language sql stable;

create or replace function public.has_role(target text)
returns boolean as $$
  select public.jwt_role() = target;
$$ language sql stable;

-- 2) Enable RLS on tables we want protected (adjust as needed)
alter table if exists public.rules enable row level security;
alter table if exists public.unsubscribe_list enable row level security;
alter table if exists public.unsubscribe_domains enable row level security;
alter table if exists public.batches enable row level security;
alter table if exists public.master_emails_temp enable row level security;

DO $$
BEGIN
  IF to_regclass('public.rules') IS NOT NULL THEN
    drop policy if exists rules_select_admin on public.rules;
    create policy rules_select_admin
    on public.rules for select
    to authenticated
    using (public.has_role('admin'));

    drop policy if exists rules_insert_admin on public.rules;
    create policy rules_insert_admin
    on public.rules for insert
    to authenticated
    with check (public.has_role('admin'));

    drop policy if exists rules_update_admin on public.rules;
    create policy rules_update_admin
    on public.rules for update
    to authenticated
    using (public.has_role('admin'))
    with check (public.has_role('admin'));

    drop policy if exists rules_delete_admin on public.rules;
    create policy rules_delete_admin
    on public.rules for delete
    to authenticated
    using (public.has_role('admin'));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.unsubscribe_list') IS NOT NULL THEN
    drop policy if exists unsub_list_select_auth on public.unsubscribe_list;
    create policy unsub_list_select_auth
    on public.unsubscribe_list for select
    to authenticated
    using (true);

    drop policy if exists unsub_list_insert_acl on public.unsubscribe_list;
    create policy unsub_list_insert_acl
    on public.unsubscribe_list for insert
    to authenticated
    with check (public.has_role('admin') or public.has_role('collector'));

    drop policy if exists unsub_list_delete_admin on public.unsubscribe_list;
    create policy unsub_list_delete_admin
    on public.unsubscribe_list for delete
    to authenticated
    using (public.has_role('admin'));
  END IF;

  IF to_regclass('public.unsubscribe_domains') IS NOT NULL THEN
    drop policy if exists unsub_domains_select_auth on public.unsubscribe_domains;
    create policy unsub_domains_select_auth
    on public.unsubscribe_domains for select
    to authenticated
    using (true);

    drop policy if exists unsub_domains_insert_acl on public.unsubscribe_domains;
    create policy unsub_domains_insert_acl
    on public.unsubscribe_domains for insert
    to authenticated
    with check (public.has_role('admin') or public.has_role('collector'));

    drop policy if exists unsub_domains_delete_admin on public.unsubscribe_domains;
    create policy unsub_domains_delete_admin
    on public.unsubscribe_domains for delete
    to authenticated
    using (public.has_role('admin'));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.batches') IS NOT NULL THEN
    drop policy if exists batches_select_auth on public.batches;
    create policy batches_select_auth
    on public.batches for select
    to authenticated
    using (true);

    drop policy if exists batches_insert_acl on public.batches;
    create policy batches_insert_acl
    on public.batches for insert
    to authenticated
    with check (public.has_role('employee') or public.has_role('collector') or public.has_role('admin'));
  END IF;

  IF to_regclass('public.master_emails_temp') IS NOT NULL THEN
    drop policy if exists staging_select_auth on public.master_emails_temp;
    create policy staging_select_auth
    on public.master_emails_temp for select
    to authenticated
    using (true);

    drop policy if exists staging_insert_acl on public.master_emails_temp;
    create policy staging_insert_acl
    on public.master_emails_temp for insert
    to authenticated
    with check (public.has_role('employee') or public.has_role('collector') or public.has_role('admin'));
  END IF;
END $$;