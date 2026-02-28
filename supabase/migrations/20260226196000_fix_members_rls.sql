alter table public.members enable row level security;

drop policy if exists "Admins can view workspace memberships" on public.members;
drop policy if exists "Admins can manage memberships" on public.members;
drop policy if exists "Admins can update memberships" on public.members;
drop policy if exists "Admins can delete memberships" on public.members;

create policy "Admins can view workspace memberships"
  on public.members for select
  using (
    exists (
      select 1
      from public.workspaces w
      where w.id = members.workspace_id
        and w.admin_user_id = auth.uid()
    )
  );

create policy "Admins can manage memberships"
  on public.members for insert
  with check (
    exists (
      select 1
      from public.workspaces w
      where w.id = members.workspace_id
        and w.admin_user_id = auth.uid()
    )
  );

create policy "Admins can update memberships"
  on public.members for update
  using (
    exists (
      select 1
      from public.workspaces w
      where w.id = members.workspace_id
        and w.admin_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.workspaces w
      where w.id = members.workspace_id
        and w.admin_user_id = auth.uid()
    )
  );

create policy "Admins can delete memberships"
  on public.members for delete
  using (
    exists (
      select 1
      from public.workspaces w
      where w.id = members.workspace_id
        and w.admin_user_id = auth.uid()
    )
  );
