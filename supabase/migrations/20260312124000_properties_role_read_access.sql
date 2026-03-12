alter table public.properties enable row level security;

drop policy if exists "Workspace members can view properties" on public.properties;
drop policy if exists "Properties can be read by role" on public.properties;

create policy "Properties can be read by role"
  on public.properties for select
  using (
    exists (
      select 1
      from public.workspaces w
      where w.id = properties.workspace_id
        and w.admin_user_id = auth.uid()
    )
    or exists (
      select 1
      from public.people p
      where p.workspace_id = properties.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.people p
      where p.id = properties.owner_id
        and p.user_id = auth.uid()
        and p.role = 'owner'
    )
  );
