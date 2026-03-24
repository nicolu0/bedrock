create or replace function public.is_workspace_member(workspace_id uuid, user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.people p
    where p.workspace_id = is_workspace_member.workspace_id
      and p.user_id = is_workspace_member.user_id
      and p.role in ('admin', 'member', 'owner', 'bedrock')
  );
$$;
