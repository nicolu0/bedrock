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
    or (
      lower(public.current_people_role(properties.workspace_id)) in ('admin', 'member', 'bedrock')
    )
    or (
      lower(public.current_people_role(properties.workspace_id)) = 'owner'
      and properties.owner_id = public.current_people_id(properties.workspace_id)
    )
  );
