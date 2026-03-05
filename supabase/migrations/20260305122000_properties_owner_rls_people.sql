drop policy if exists "Workspace members can view properties" on public.properties;

create policy "Workspace members can view properties"
  on public.properties for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = properties.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.people p
      where p.id = properties.owner_id
        and p.user_id = auth.uid()
    )
  );

drop policy if exists "Workspace members can view units" on public.units;

create policy "Workspace members can view units"
  on public.units for select
  using (
    exists (
      select 1
      from public.properties p
      join public.members m on m.workspace_id = p.workspace_id
      where p.id = units.property_id
        and m.user_id = auth.uid()
        and m.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.properties p
      join public.people o on o.id = p.owner_id
      where p.id = units.property_id
        and o.user_id = auth.uid()
    )
  );
