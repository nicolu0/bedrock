alter table public.people enable row level security;

drop policy if exists "People can be read by role" on public.people;

create policy "People can be read by role"
  on public.people for select
  using (
    exists (
      select 1
      from public.workspaces w
      where w.id = people.workspace_id
        and w.admin_user_id = auth.uid()
    )
    or current_people_role(people.workspace_id) in ('admin', 'member')
  );
