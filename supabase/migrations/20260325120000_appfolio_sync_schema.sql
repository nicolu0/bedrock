-- AppFolio sync schema
-- Adds appfolio_id columns to entity tables, workspace integration flag, and pg_cron job

-- Workspace-level AppFolio integration flag
alter table public.workspaces
  add column if not exists appfolio_enabled boolean not null default false;

-- issues: source + appfolio_id (may already exist in DB from prior applied migration)
alter table public.issues
  add column if not exists source text check (source in ('native', 'appfolio')) default 'native',
  add column if not exists appfolio_id text;

create unique index if not exists issues_appfolio_id_workspace_unique
  on public.issues (workspace_id, appfolio_id)
  where appfolio_id is not null;

-- properties: appfolio_property_id
alter table public.properties
  add column if not exists appfolio_property_id text;

create unique index if not exists properties_appfolio_id_workspace_unique
  on public.properties (workspace_id, appfolio_property_id)
  where appfolio_property_id is not null;

-- units: appfolio_unit_id
alter table public.units
  add column if not exists appfolio_unit_id text;

create unique index if not exists units_appfolio_id_unique
  on public.units (appfolio_unit_id)
  where appfolio_unit_id is not null;

-- vendors: appfolio_vendor_id
alter table public.vendors
  add column if not exists appfolio_vendor_id text;

create unique index if not exists vendors_appfolio_id_workspace_unique
  on public.vendors (workspace_id, appfolio_vendor_id)
  where appfolio_vendor_id is not null;

-- notifications: meta column (jsonb) for appfolio_action_required type
-- (may already exist — add only if missing)
alter table public.notifications
  add column if not exists meta jsonb,
  add column if not exists requires_action boolean not null default false,
  add column if not exists type text;

-- people: bedrock role (for internal founders — LAPM workspace only)
-- No schema change needed; role is already a text column without enum constraint

-- pg_cron: schedule appfolio-sync edge function every 60 seconds
-- BEFORE APPLYING: substitute {PROJECT_REF} and {SERVICE_ROLE_KEY} with real values.
-- Get PROJECT_REF from: Supabase dashboard → Project Settings → General → Reference ID
-- Get SERVICE_ROLE_KEY from: Supabase dashboard → Project Settings → API → service_role key
--
-- select cron.schedule(
--   'appfolio-sync',
--   '* * * * *',
--   $$
--     select net.http_post(
--       url := 'https://{PROJECT_REF}.supabase.co/functions/v1/appfolio-sync',
--       headers := '{"Content-Type": "application/json", "Authorization": "Bearer {SERVICE_ROLE_KEY}"}'::jsonb,
--       body := '{}'::jsonb
--     );
--   $$
-- );
