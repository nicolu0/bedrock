alter table public.properties enable row level security;

create or replace function public.current_people_id(workspace_id uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select id
  from public.people
  where workspace_id = $1
    and user_id = auth.uid()
  order by created_at asc
  limit 1
$$;

create or replace function public.current_people_role(workspace_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role::text
  from public.people
  where workspace_id = $1
    and user_id = auth.uid()
  order by created_at asc
  limit 1
$$;

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
      lower(public.current_people_role(properties.workspace_id)) in ('admin', 'member')
    )
    or (
      lower(public.current_people_role(properties.workspace_id)) = 'owner'
      and properties.owner_id = public.current_people_id(properties.workspace_id)
    )
  );
