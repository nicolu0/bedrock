alter table public.properties enable row level security;

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
        and lower(p.role::text) in ('admin', 'member')
    )
    or exists (
      select 1
      from public.people p
      where p.workspace_id = properties.workspace_id
        and p.user_id = auth.uid()
        and lower(p.role::text) = 'owner'
        and p.id = properties.owner_id
    )
  );
