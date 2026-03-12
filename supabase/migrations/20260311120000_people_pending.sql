alter table public.people
  add column if not exists pending boolean not null default false;

create index if not exists people_workspace_pending_idx
  on public.people(workspace_id, pending);
