create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  issue_id uuid not null,
  type text not null,
  from_email text,
  to_emails text[],
  subject text,
  body text,
  data jsonb not null default '{}'::jsonb,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activity_logs_workspace_id_fkey foreign key (workspace_id) references public.workspaces(id) on delete cascade,
  constraint activity_logs_issue_id_fkey foreign key (issue_id) references public.issues(id) on delete cascade,
  constraint activity_logs_created_by_fkey foreign key (created_by) references public.users(id) on delete set null,
  constraint activity_logs_type_check check (type in ('comment', 'status_change', 'assignee_change', 'email_outbound', 'email_inbound'))
);

create index if not exists activity_logs_workspace_id_idx on public.activity_logs (workspace_id);
create index if not exists activity_logs_issue_id_idx on public.activity_logs (issue_id);
create index if not exists activity_logs_issue_created_at_idx on public.activity_logs (issue_id, created_at desc);

create table public.email_drafts (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null,
  sender text,
  recipient text,
  subject text,
  body text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_drafts_issue_id_fkey foreign key (issue_id) references public.issues(id) on delete cascade
);

create unique index if not exists email_drafts_issue_id_idx on public.email_drafts (issue_id);
create index if not exists email_drafts_issue_created_at_idx on public.email_drafts (issue_id, created_at desc);

alter table public.activity_logs enable row level security;

alter table public.email_drafts enable row level security;

drop policy if exists "Workspace members can view activity logs" on public.activity_logs;
drop policy if exists "Workspace members can insert activity logs" on public.activity_logs;
drop policy if exists "Workspace members can update activity logs" on public.activity_logs;
drop policy if exists "Workspace members can delete activity logs" on public.activity_logs;

drop policy if exists "Workspace members can view email drafts" on public.email_drafts;
drop policy if exists "Workspace members can insert email drafts" on public.email_drafts;
drop policy if exists "Workspace members can update email drafts" on public.email_drafts;
drop policy if exists "Workspace members can delete email drafts" on public.email_drafts;

create policy "Workspace members can view activity logs"
  on public.activity_logs for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = activity_logs.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert activity logs"
  on public.activity_logs for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = activity_logs.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update activity logs"
  on public.activity_logs for update
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = activity_logs.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete activity logs"
  on public.activity_logs for delete
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = activity_logs.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can view email drafts"
  on public.email_drafts for select
  using (
    exists (
      select 1
      from public.issues i
      join public.members m on m.workspace_id = i.workspace_id
      where i.id = email_drafts.issue_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert email drafts"
  on public.email_drafts for insert
  with check (
    exists (
      select 1
      from public.issues i
      join public.members m on m.workspace_id = i.workspace_id
      where i.id = email_drafts.issue_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update email drafts"
  on public.email_drafts for update
  using (
    exists (
      select 1
      from public.issues i
      join public.members m on m.workspace_id = i.workspace_id
      where i.id = email_drafts.issue_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete email drafts"
  on public.email_drafts for delete
  using (
    exists (
      select 1
      from public.issues i
      join public.members m on m.workspace_id = i.workspace_id
      where i.id = email_drafts.issue_id
        and m.user_id = auth.uid()
    )
  );
