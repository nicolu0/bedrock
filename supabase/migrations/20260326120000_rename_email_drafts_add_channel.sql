-- Rename table (indexes and FK constraints auto-rename; trigger stays bound by OID)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'email_drafts'
  ) and not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'drafts'
  ) then
    alter table public.email_drafts rename to drafts;
  end if;
end $$;

-- Add channel field (existing rows default to 'email' — correct)
alter table public.drafts
  add column if not exists channel text not null default 'email'
    check (channel in ('email', 'appfolio'));

-- Ensure realtime publication covers the renamed table
-- (Supabase may track by name in its metadata layer; ADD TABLE is idempotent)
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'drafts'
  ) then
    alter publication supabase_realtime add table public.drafts;
  end if;
end $$;
