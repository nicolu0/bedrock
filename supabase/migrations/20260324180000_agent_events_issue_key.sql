alter table public.agent_events
  add column if not exists issue_id uuid null;

alter table public.agent_events
  add constraint agent_events_issue_id_fkey
  foreign key (issue_id) references public.issues(id) on delete set null;

alter table public.agent_events
  add column if not exists updated_at timestamptz not null default now();

update public.agent_events
set updated_at = created_at
where updated_at is null;

drop index if exists agent_events_workspace_run_unique;

create unique index if not exists agent_events_workspace_issue_unique
  on public.agent_events (workspace_id, issue_id)
  where issue_id is not null;

create index if not exists agent_events_issue_id_idx
  on public.agent_events (issue_id);
