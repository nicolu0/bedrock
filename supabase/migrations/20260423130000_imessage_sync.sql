-- iMessage sync from Mac → Bedrock
-- Adds workspace-level config for a single coordinator group chat,
-- extends threads.participant_type to allow 'coordinator', and
-- introduces workspace_api_keys for authenticating the local sync script.

-- 1) Allow 'coordinator' participant_type on threads
alter table public.threads drop constraint if exists threads_participant_type_check;
alter table public.threads add constraint threads_participant_type_check
  check (participant_type in ('tenant', 'vendor', 'unknown', 'manager', 'coordinator'));

-- 2) Workspace-level coordinator iMessage config
alter table public.workspaces
  add column if not exists coordinator_chat_guid text,
  add column if not exists coordinator_bedrock_handles text[] not null default '{}'::text[],
  add column if not exists coordinator_label text not null default 'Jose',
  add column if not exists coordinator_thread_id uuid references public.threads(id) on delete set null;

-- 3) API keys for the local sync script (hashed)
create table if not exists public.workspace_api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  key_hash text not null,
  key_prefix text not null,
  scope text not null default 'imessage_ingest'
    check (scope in ('imessage_ingest')),
  last_used_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists workspace_api_keys_key_hash_unique
  on public.workspace_api_keys (key_hash);
create index if not exists workspace_api_keys_workspace_idx
  on public.workspace_api_keys (workspace_id);

alter table public.workspace_api_keys enable row level security;

-- Service role bypasses RLS; explicit deny to anon/authenticated (keys are managed server-side).
drop policy if exists "workspace_api_keys_no_public_access" on public.workspace_api_keys;
create policy "workspace_api_keys_no_public_access"
  on public.workspace_api_keys
  for all
  to authenticated, anon
  using (false)
  with check (false);

-- 4) Speed up the coordinator chat query (thread_id + timestamp)
create index if not exists messages_thread_id_timestamp_idx
  on public.messages (thread_id, timestamp)
  where thread_id is not null;

-- 5) Speed up channel-scoped queries (e.g. imessage-only loads)
create index if not exists messages_workspace_channel_timestamp_idx
  on public.messages (workspace_id, channel, timestamp);
