drop policy if exists "Workspace members can view properties" on public.properties;

create policy "Workspace members can view properties"
  on public.properties for select
  using (
    exists (
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

drop policy if exists "Workspace members can view units" on public.units;

create policy "Workspace members can view units"
  on public.units for select
  using (
    exists (
      select 1
      from public.properties pr
      join public.people p on p.workspace_id = pr.workspace_id
      where pr.id = units.property_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.properties pr
      join public.people o on o.id = pr.owner_id
      where pr.id = units.property_id
        and o.user_id = auth.uid()
        and o.role = 'owner'
    )
  );
