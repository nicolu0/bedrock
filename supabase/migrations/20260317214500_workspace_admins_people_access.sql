create or replace function public.is_workspace_admin(workspace_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.workspaces w
    where w.id = $1
      and w.admin_user_id = auth.uid()
  )
  or lower(public.current_people_role($1)) = 'admin'
$$;

grant execute on function public.is_workspace_admin(uuid) to authenticated;

alter table public.workspaces enable row level security;

drop policy if exists "Members can view workspaces" on public.workspaces;
drop policy if exists "Admins can update workspaces" on public.workspaces;

create policy "Members can view workspaces"
  on public.workspaces for select
  using (
    lower(public.current_people_role(workspaces.id)) in ('admin', 'member', 'owner')
    or workspaces.admin_user_id = auth.uid()
  );

create policy "Admins can update workspaces"
  on public.workspaces for update
  using (public.is_workspace_admin(workspaces.id));
