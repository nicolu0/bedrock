drop table if exists public.tasks cascade;

drop table if exists public.issues cascade;

create table public.issues (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid null,
  workspace_id uuid not null,
  unit_id uuid not null,
  name text not null,
  status text not null default 'todo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint issues_parent_id_fkey foreign key (parent_id) references public.issues(id) on delete cascade,
  constraint issues_workspace_id_fkey foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint issues_unit_id_fkey foreign key (unit_id) references public.units(id) on delete cascade,
  constraint issues_status_check check (status in ('todo', 'in_progress', 'done'))
);

create index if not exists issues_workspace_id_idx on public.issues (workspace_id);
create index if not exists issues_unit_id_idx on public.issues (unit_id);
create index if not exists issues_parent_id_idx on public.issues (parent_id);

alter table public.threads
  drop constraint if exists threads_issue_id_fkey;

alter table public.threads
  add constraint threads_issue_id_fkey
  foreign key (issue_id) references public.issues(id) on delete set null;

alter table public.messages
  drop constraint if exists messages_issue_id_fkey;

alter table public.messages
  add constraint messages_issue_id_fkey
  foreign key (issue_id) references public.issues(id) on delete set null;

alter table public.notifications
  drop constraint if exists notifications_issue_id_fkey;

alter table public.notifications
  add constraint notifications_issue_id_fkey
  foreign key (issue_id) references public.issues(id) on delete set null;
