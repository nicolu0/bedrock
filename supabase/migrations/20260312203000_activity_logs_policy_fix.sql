create or replace function public.is_workspace_member(workspace_id uuid, user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.people p
    where p.workspace_id = is_workspace_member.workspace_id
      and p.user_id = is_workspace_member.user_id
      and p.role in ('admin', 'member', 'owner')
  );
$$;

alter table public.activity_logs enable row level security;

drop policy if exists "Workspace members can view activity logs" on public.activity_logs;
drop policy if exists "Workspace members can insert activity logs" on public.activity_logs;
drop policy if exists "Workspace members can update activity logs" on public.activity_logs;
drop policy if exists "Workspace members can delete activity logs" on public.activity_logs;

create policy "Workspace members can view activity logs"
  on public.activity_logs for select
  using (
    public.is_workspace_member(activity_logs.workspace_id, auth.uid())
  );

create policy "Workspace members can insert activity logs"
  on public.activity_logs for insert
  with check (
    public.is_workspace_member(activity_logs.workspace_id, auth.uid())
  );

create policy "Workspace members can update activity logs"
  on public.activity_logs for update
  using (
    public.is_workspace_member(activity_logs.workspace_id, auth.uid())
  )
  with check (
    public.is_workspace_member(activity_logs.workspace_id, auth.uid())
  );

create policy "Workspace members can delete activity logs"
  on public.activity_logs for delete
  using (
    public.is_workspace_member(activity_logs.workspace_id, auth.uid())
  );
