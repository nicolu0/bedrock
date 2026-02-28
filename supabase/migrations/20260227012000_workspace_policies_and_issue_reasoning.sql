create table if not exists public.workspace_policies (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  policy_text text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.workspace_policies enable row level security;

drop policy if exists "Workspace members can view workspace policies" on public.workspace_policies;
drop policy if exists "Workspace members can insert workspace policies" on public.workspace_policies;
drop policy if exists "Workspace members can update workspace policies" on public.workspace_policies;
drop policy if exists "Workspace members can delete workspace policies" on public.workspace_policies;

create policy "Workspace members can view workspace policies"
  on public.workspace_policies for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = workspace_policies.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert workspace policies"
  on public.workspace_policies for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = workspace_policies.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update workspace policies"
  on public.workspace_policies for update
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = workspace_policies.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete workspace policies"
  on public.workspace_policies for delete
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = workspace_policies.workspace_id
        and m.user_id = auth.uid()
    )
  );

alter table public.issues
  add column if not exists reasoning text;
