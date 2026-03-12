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
  order by (lower(role::text) = 'owner') desc, created_at asc
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
  order by (lower(role::text) = 'owner') desc, created_at asc
  limit 1
$$;
