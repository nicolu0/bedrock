alter table public.issues enable row level security;

drop policy if exists "Issues can be read by role" on public.issues;
drop policy if exists "Admins can insert issues" on public.issues;
drop policy if exists "Admins can update issues" on public.issues;
drop policy if exists "Admins can delete issues" on public.issues;

create policy "Issues can be read by role"
  on public.issues for select
  using (
    exists (
      select 1
      from public.people p
      where p.workspace_id = issues.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'bedrock')
    )
    or exists (
      select 1
      from public.people p
      where p.workspace_id = issues.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('member', 'vendor')
        and issues.assignee_id = auth.uid()
    )
    or exists (
      select 1
      from public.people p
      join public.units u on u.id = issues.unit_id
      join public.properties pr on pr.id = u.property_id
      where p.workspace_id = issues.workspace_id
        and p.user_id = auth.uid()
        and p.role = 'owner'
        and pr.owner_id = p.id
    )
  );

create policy "Admins can insert issues"
  on public.issues for insert
  with check (
    exists (
      select 1
      from public.people p
      where p.workspace_id = issues.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'bedrock')
    )
  );

create policy "Admins can update issues"
  on public.issues for update
  using (
    exists (
      select 1
      from public.people p
      where p.workspace_id = issues.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'bedrock')
    )
  )
  with check (
    exists (
      select 1
      from public.people p
      where p.workspace_id = issues.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'bedrock')
    )
  );

create policy "Admins can delete issues"
  on public.issues for delete
  using (
    exists (
      select 1
      from public.people p
      where p.workspace_id = issues.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'bedrock')
    )
  );
