-- Per-customer ingest alias: the Google Group address AppFolio WO mail is relayed
-- through. pubsub-hook routes inbound mail to the workspace whose alias appears in
-- the message headers (replaces the hardcoded WORKSPACE_BY_ALIAS map in
-- src/routes/api/pubsub-hook/+server.js so new customers = a row, not a code edit).
alter table public.workspaces add column if not exists alias text;

create unique index if not exists workspaces_alias_key
  on public.workspaces (alias) where alias is not null;

comment on column public.workspaces.alias is
  'Ingest email alias (Google Group address) AppFolio WO mail is relayed through; pubsub-hook routes inbound mail to this workspace when the alias appears in the message headers.';

-- Seed the two live customers (idempotent; no-ops on envs without these workspaces).
update public.workspaces set alias = 'lapm@usebedrock.co'
  where name = 'LAPM' and alias is null;
update public.workspaces set alias = 'greenoakpropertymanagement@usebedrock.co'
  where name = 'Green Oak Property Management' and alias is null;
