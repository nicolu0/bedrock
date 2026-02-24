alter table if exists public.teams
  rename to workspaces;

alter table public.workspaces
  rename column owner_user_id to admin_user_id;

alter index if exists teams_owner_user_id_key
  rename to workspaces_admin_user_id_key;

alter table if exists public.team_members
  rename to members;

alter table public.members
  rename column team_id to workspace_id;

alter table public.members
  drop constraint if exists team_members_role_check;

alter table public.members
  add constraint members_role_check check (role in ('admin', 'member', 'owner'));

drop index if exists team_members_user_id_key;

alter index if exists team_members_team_id_idx
  rename to members_workspace_id_idx;

create unique index if not exists members_workspace_user_key
  on public.members(workspace_id, user_id);

alter table public.properties
  rename column team_id to workspace_id;

alter table public.vendors
  rename column team_id to workspace_id;

alter table public.tasks
  rename column team_id to workspace_id;

alter index if exists properties_team_id_idx
  rename to properties_workspace_id_idx;

alter index if exists vendors_team_id_idx
  rename to vendors_workspace_id_idx;

alter index if exists tasks_team_id_idx
  rename to tasks_workspace_id_idx;

alter table public.issues
  add column if not exists workspace_id uuid;

alter table public.threads
  add column if not exists workspace_id uuid;

update public.issues i
set workspace_id = p.workspace_id
from public.tenants t
join public.units u on u.id = t.unit_id
join public.properties p on p.id = u.property_id
where i.tenant_id = t.id
  and i.workspace_id is null;

update public.threads th
set workspace_id = i.workspace_id
from public.issues i
where th.issue_id = i.id
  and th.workspace_id is null;

update public.threads th
set workspace_id = p.workspace_id
from public.tenants t
join public.units u on u.id = t.unit_id
join public.properties p on p.id = u.property_id
where th.tenant_id = t.id
  and th.workspace_id is null;

alter table public.issues
  alter column workspace_id set not null;

alter table public.threads
  alter column workspace_id set not null;

alter table public.issues
  add constraint issues_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;

alter table public.threads
  add constraint threads_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;

create index if not exists issues_workspace_id_idx
  on public.issues(workspace_id);

create index if not exists threads_workspace_id_idx
  on public.threads(workspace_id);

alter table public.workspaces
  add column if not exists slug text;

with base as (
  select
    id,
    coalesce(nullif(lower(regexp_replace(name, '[^a-z0-9]+', '-', 'g')), ''), 'workspace') as base_slug
  from public.workspaces
),
dedup as (
  select
    id,
    base_slug,
    row_number() over (partition by base_slug order by id) as rn
  from base
)
update public.workspaces w
set slug = case when dedup.rn = 1 then dedup.base_slug else dedup.base_slug || '-' || dedup.rn end
from dedup
where w.id = dedup.id
  and (w.slug is null or w.slug = '');

alter table public.workspaces
  alter column slug set not null;

create unique index if not exists workspaces_slug_key
  on public.workspaces(slug);

insert into public.members (workspace_id, user_id, role)
select w.id, w.admin_user_id, 'admin'
from public.workspaces w
where w.admin_user_id is not null
on conflict (workspace_id, user_id) do nothing;

drop policy if exists "Team members can view teams" on public.workspaces;
drop policy if exists "Owners can create teams" on public.workspaces;
drop policy if exists "Admins can update teams" on public.workspaces;

drop policy if exists "Members can view own membership" on public.members;
drop policy if exists "Admins can view team memberships" on public.members;
drop policy if exists "Admins can manage memberships" on public.members;
drop policy if exists "Admins can update memberships" on public.members;
drop policy if exists "Admins can delete memberships" on public.members;

drop policy if exists "Team members can view properties" on public.properties;
drop policy if exists "Team members can insert properties" on public.properties;
drop policy if exists "Team members can update properties" on public.properties;
drop policy if exists "Team members can delete properties" on public.properties;

drop policy if exists "Team members can view units" on public.units;
drop policy if exists "Team members can insert units" on public.units;
drop policy if exists "Team members can update units" on public.units;
drop policy if exists "Team members can delete units" on public.units;

drop policy if exists "Team members can view tenants" on public.tenants;
drop policy if exists "Team members can insert tenants" on public.tenants;
drop policy if exists "Team members can update tenants" on public.tenants;
drop policy if exists "Team members can delete tenants" on public.tenants;

drop policy if exists "Team members can view issues" on public.issues;
drop policy if exists "Team members can insert issues" on public.issues;
drop policy if exists "Team members can update issues" on public.issues;
drop policy if exists "Team members can delete issues" on public.issues;

drop policy if exists "Team members can view threads" on public.threads;
drop policy if exists "Team members can insert threads" on public.threads;
drop policy if exists "Team members can update threads" on public.threads;
drop policy if exists "Team members can delete threads" on public.threads;

drop policy if exists "Team members can view messages" on public.messages;
drop policy if exists "Team members can insert messages" on public.messages;
drop policy if exists "Team members can update messages" on public.messages;
drop policy if exists "Team members can delete messages" on public.messages;

drop policy if exists "Team members can view vendors" on public.vendors;
drop policy if exists "Team members can insert vendors" on public.vendors;
drop policy if exists "Team members can update vendors" on public.vendors;
drop policy if exists "Team members can delete vendors" on public.vendors;

drop policy if exists "Team members can view tasks" on public.tasks;
drop policy if exists "Team members can insert tasks" on public.tasks;
drop policy if exists "Team members can update tasks" on public.tasks;
drop policy if exists "Team members can delete tasks" on public.tasks;

drop policy if exists "Team members can view owners" on public.owners;
drop policy if exists "Team members can insert owners" on public.owners;
drop policy if exists "Team members can update owners" on public.owners;
drop policy if exists "Team members can delete owners" on public.owners;

drop policy if exists "Team members can view property owners" on public.property_owners;
drop policy if exists "Team members can insert property owners" on public.property_owners;
drop policy if exists "Team members can update property owners" on public.property_owners;
drop policy if exists "Team members can delete property owners" on public.property_owners;

create policy "Members can view workspaces"
  on public.workspaces for select
  using (
    exists (
      select 1
      from public.members
      where members.workspace_id = workspaces.id
        and members.user_id = auth.uid()
    )
  );

create policy "Admins can create workspaces"
  on public.workspaces for insert
  with check (admin_user_id = auth.uid());

create policy "Admins can update workspaces"
  on public.workspaces for update
  using (
    exists (
      select 1
      from public.members
      where members.workspace_id = workspaces.id
        and members.user_id = auth.uid()
        and members.role = 'admin'
    )
  );

create policy "Members can view own membership"
  on public.members for select
  using (user_id = auth.uid());

create policy "Admins can view workspace memberships"
  on public.members for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = members.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
    )
  );

create policy "Admins can manage memberships"
  on public.members for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = members.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
    )
  );

create policy "Admins can update memberships"
  on public.members for update
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = members.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = members.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
    )
  );

create policy "Admins can delete memberships"
  on public.members for delete
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = members.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
    )
  );

create policy "Workspace members can view properties"
  on public.properties for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = properties.workspace_id
        and m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.property_owners po
      join public.owners o on o.id = po.owner_id
      where po.property_id = properties.id
        and o.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert properties"
  on public.properties for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = properties.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update properties"
  on public.properties for update
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = properties.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete properties"
  on public.properties for delete
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = properties.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can view units"
  on public.units for select
  using (
    exists (
      select 1
      from public.properties p
      join public.members m on m.workspace_id = p.workspace_id
      where p.id = units.property_id
        and m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.property_owners po
      join public.owners o on o.id = po.owner_id
      where po.property_id = units.property_id
        and o.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert units"
  on public.units for insert
  with check (
    exists (
      select 1
      from public.properties p
      join public.members m on m.workspace_id = p.workspace_id
      where p.id = units.property_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update units"
  on public.units for update
  using (
    exists (
      select 1
      from public.properties p
      join public.members m on m.workspace_id = p.workspace_id
      where p.id = units.property_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete units"
  on public.units for delete
  using (
    exists (
      select 1
      from public.properties p
      join public.members m on m.workspace_id = p.workspace_id
      where p.id = units.property_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can view tenants"
  on public.tenants for select
  using (
    exists (
      select 1
      from public.units u
      join public.properties p on p.id = u.property_id
      join public.members m on m.workspace_id = p.workspace_id
      where u.id = tenants.unit_id
        and m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.property_owners po
      join public.owners o on o.id = po.owner_id
      where po.property_id = (select property_id from public.units where id = tenants.unit_id)
        and o.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert tenants"
  on public.tenants for insert
  with check (
    exists (
      select 1
      from public.units u
      join public.properties p on p.id = u.property_id
      join public.members m on m.workspace_id = p.workspace_id
      where u.id = tenants.unit_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update tenants"
  on public.tenants for update
  using (
    exists (
      select 1
      from public.units u
      join public.properties p on p.id = u.property_id
      join public.members m on m.workspace_id = p.workspace_id
      where u.id = tenants.unit_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete tenants"
  on public.tenants for delete
  using (
    exists (
      select 1
      from public.units u
      join public.properties p on p.id = u.property_id
      join public.members m on m.workspace_id = p.workspace_id
      where u.id = tenants.unit_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can view issues"
  on public.issues for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = issues.workspace_id
        and m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.property_owners po on po.property_id = u.property_id
      join public.owners o on o.id = po.owner_id
      where t.id = issues.tenant_id
        and o.user_id = auth.uid()
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

create policy "Workspace members can view threads"
  on public.threads for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = threads.workspace_id
        and m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.threads th
      join public.tenants t on t.id = th.tenant_id
      join public.units u on u.id = t.unit_id
      join public.property_owners po on po.property_id = u.property_id
      join public.owners o on o.id = po.owner_id
      where th.id = threads.id
        and o.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert threads"
  on public.threads for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = threads.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update threads"
  on public.threads for update
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = threads.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete threads"
  on public.threads for delete
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = threads.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can view messages"
  on public.messages for select
  using (
    exists (
      select 1
      from public.threads th
      join public.members m on m.workspace_id = th.workspace_id
      where th.id = messages.thread_id
        and m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.threads th
      join public.tenants t on t.id = th.tenant_id
      join public.units u on u.id = t.unit_id
      join public.property_owners po on po.property_id = u.property_id
      join public.owners o on o.id = po.owner_id
      where th.id = messages.thread_id
        and o.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert messages"
  on public.messages for insert
  with check (
    exists (
      select 1
      from public.threads th
      join public.members m on m.workspace_id = th.workspace_id
      where th.id = messages.thread_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update messages"
  on public.messages for update
  using (
    exists (
      select 1
      from public.threads th
      join public.members m on m.workspace_id = th.workspace_id
      where th.id = messages.thread_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete messages"
  on public.messages for delete
  using (
    exists (
      select 1
      from public.threads th
      join public.members m on m.workspace_id = th.workspace_id
      where th.id = messages.thread_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can view vendors"
  on public.vendors for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = vendors.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert vendors"
  on public.vendors for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = vendors.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update vendors"
  on public.vendors for update
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = vendors.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete vendors"
  on public.vendors for delete
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = vendors.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can view tasks"
  on public.tasks for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = tasks.workspace_id
        and m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.issues i
      join public.tenants t on t.id = i.tenant_id
      join public.units u on u.id = t.unit_id
      join public.property_owners po on po.property_id = u.property_id
      join public.owners o on o.id = po.owner_id
      where i.id = tasks.issue_id
        and o.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert tasks"
  on public.tasks for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = tasks.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update tasks"
  on public.tasks for update
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = tasks.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete tasks"
  on public.tasks for delete
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = tasks.workspace_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can view owners"
  on public.owners for select
  using (
    exists (
      select 1
      from public.property_owners po
      join public.properties p on p.id = po.property_id
      join public.members m on m.workspace_id = p.workspace_id
      where po.owner_id = owners.id
        and m.user_id = auth.uid()
    )
    or owners.user_id = auth.uid()
  );

create policy "Workspace members can insert owners"
  on public.owners for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.user_id = auth.uid()
    )
    or owners.user_id = auth.uid()
  );

create policy "Workspace members can update owners"
  on public.owners for update
  using (
    exists (
      select 1
      from public.property_owners po
      join public.properties p on p.id = po.property_id
      join public.members m on m.workspace_id = p.workspace_id
      where po.owner_id = owners.id
        and m.user_id = auth.uid()
    )
    or owners.user_id = auth.uid()
  );

create policy "Workspace members can delete owners"
  on public.owners for delete
  using (
    exists (
      select 1
      from public.property_owners po
      join public.properties p on p.id = po.property_id
      join public.members m on m.workspace_id = p.workspace_id
      where po.owner_id = owners.id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can view property owners"
  on public.property_owners for select
  using (
    exists (
      select 1
      from public.properties p
      join public.members m on m.workspace_id = p.workspace_id
      where p.id = property_owners.property_id
        and m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.owners o
      where o.id = property_owners.owner_id
        and o.user_id = auth.uid()
    )
  );

create policy "Workspace members can insert property owners"
  on public.property_owners for insert
  with check (
    exists (
      select 1
      from public.properties p
      join public.members m on m.workspace_id = p.workspace_id
      where p.id = property_owners.property_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can update property owners"
  on public.property_owners for update
  using (
    exists (
      select 1
      from public.properties p
      join public.members m on m.workspace_id = p.workspace_id
      where p.id = property_owners.property_id
        and m.user_id = auth.uid()
    )
  );

create policy "Workspace members can delete property owners"
  on public.property_owners for delete
  using (
    exists (
      select 1
      from public.properties p
      join public.members m on m.workspace_id = p.workspace_id
      where p.id = property_owners.property_id
        and m.user_id = auth.uid()
    )
  );
