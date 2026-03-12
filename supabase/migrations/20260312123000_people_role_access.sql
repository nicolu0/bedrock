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
    or exists (
      select 1
      from public.people p
      where p.workspace_id = people.workspace_id
        and p.user_id = auth.uid()
        and p.role in ('admin', 'member')
    )
  );
