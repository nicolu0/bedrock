alter table public.issues enable row level security;

drop policy if exists "Workspace members can view issues" on public.issues;
drop policy if exists "Workspace members can insert issues" on public.issues;
drop policy if exists "Workspace members can update issues" on public.issues;
drop policy if exists "Workspace members can delete issues" on public.issues;

create policy "Workspace members can view issues"
  on public.issues for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = issues.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert issues"
  on public.issues for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = issues.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update issues"
  on public.issues for update
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = issues.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete issues"
  on public.issues for delete
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = issues.workspace_id
        and m.user_id = auth.uid()
    )
  );
