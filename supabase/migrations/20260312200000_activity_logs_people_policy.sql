alter table public.activity_logs enable row level security;

drop policy if exists "Workspace members can view activity logs" on public.activity_logs;
drop policy if exists "Workspace members can insert activity logs" on public.activity_logs;
drop policy if exists "Workspace members can update activity logs" on public.activity_logs;
drop policy if exists "Workspace members can delete activity logs" on public.activity_logs;

create policy "Workspace members can view activity logs"
  on public.activity_logs for select
  using (
    exists (
      select 1
      from public.people p
      where p.workspace_id = activity_logs.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'member', 'owner')
    )
  );

create policy "Workspace members can insert activity logs"
  on public.activity_logs for insert
  with check (
    exists (
      select 1
      from public.people p
      where p.workspace_id = activity_logs.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'member', 'owner')
    )
  );

create policy "Workspace members can update activity logs"
  on public.activity_logs for update
  using (
    exists (
      select 1
      from public.people p
      where p.workspace_id = activity_logs.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'member', 'owner')
    )
  )
  with check (
    exists (
      select 1
      from public.people p
      where p.workspace_id = activity_logs.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'member', 'owner')
    )
  );

create policy "Workspace members can delete activity logs"
  on public.activity_logs for delete
  using (
    exists (
      select 1
      from public.people p
      where p.workspace_id = activity_logs.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'member', 'owner')
    )
  );
