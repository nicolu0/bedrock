alter table public.workspaces
  drop constraint if exists workspaces_admin_user_id_key;

drop index if exists workspaces_admin_user_id_key;

insert into public.workspaces (name, slug, admin_user_id)
select 'LAPM', 'lapm', '089ed731-51c8-48a8-af30-8967841bf268'
where not exists (
  select 1
  from public.workspaces
  where slug = 'lapm'
);

insert into public.people (workspace_id, user_id, role, name, pending)
select w.id, u.id, 'admin', u.name, false
from public.workspaces w
join public.users u on u.id in (
  '089ed731-51c8-48a8-af30-8967841bf268',
  '8d71c46b-6fed-4ce0-816c-e80bda1da323'
)
where w.slug = 'lapm'
  and not exists (
    select 1
    from public.people p
    where p.workspace_id = w.id
      and p.user_id = u.id
  );
