create table public.agent_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid null,
  run_id uuid not null,
  step int null,
  stage text not null,
  message text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_events_workspace_id_fkey foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint agent_events_user_id_fkey foreign key (user_id) references public.users(id) on delete set null
);

create index if not exists agent_events_workspace_id_idx on public.agent_events (workspace_id);
create index if not exists agent_events_workspace_created_at_idx on public.agent_events (workspace_id, created_at desc);
create index if not exists agent_events_run_id_created_at_idx on public.agent_events (run_id, created_at desc);

alter table public.agent_events enable row level security;

drop policy if exists "Workspace members can view agent events" on public.agent_events;

create policy "Workspace members can view agent events"
  on public.agent_events for select
  using (
    public.is_workspace_member(agent_events.workspace_id, auth.uid())
  );

alter table public.agent_events replica identity full;
alter publication supabase_realtime add table public.agent_events;
