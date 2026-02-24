alter table if exists public.buildings
  rename to properties;

alter index if exists buildings_user_id_idx
  rename to properties_user_id_idx;

alter table if exists public.units
  rename column building_id to property_id;

alter table public.units
  drop constraint if exists units_building_id_fkey;

alter table public.units
  add constraint units_property_id_fkey
  foreign key (property_id) references public.properties(id) on delete cascade;

alter index if exists units_building_id_idx
  rename to units_property_id_idx;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists teams_owner_user_id_key
  on public.teams(owner_user_id);

create table if not exists public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_members_role_check check (role in ('admin', 'member'))
);

create unique index if not exists team_members_user_id_key
  on public.team_members(user_id);

create index if not exists team_members_team_id_idx
  on public.team_members(team_id);

insert into public.teams (id, name, owner_user_id)
select gen_random_uuid(), concat(users.name, ' Team'), users.id
from public.users
where not exists (
  select 1
  from public.teams
  where teams.owner_user_id = users.id
);

insert into public.team_members (team_id, user_id, role)
select teams.id, users.id, 'admin'
from public.users
join public.teams on teams.owner_user_id = users.id
on conflict (user_id) do nothing;

alter table public.properties
  add column if not exists team_id uuid;

update public.properties
set team_id = teams.id
from public.teams
where teams.owner_user_id = properties.user_id
  and properties.team_id is null;

alter table public.properties
  alter column team_id set not null;

alter table public.properties
  add constraint properties_team_id_fkey
  foreign key (team_id) references public.teams(id) on delete cascade;

create index if not exists properties_team_id_idx
  on public.properties(team_id);

drop policy if exists "Users can view own buildings" on public.properties;
drop policy if exists "Users can insert own buildings" on public.properties;
drop policy if exists "Users can update own buildings" on public.properties;
drop policy if exists "Users can delete own buildings" on public.properties;

drop policy if exists "Users can view own units" on public.units;
drop policy if exists "Users can insert own units" on public.units;
drop policy if exists "Users can update own units" on public.units;
drop policy if exists "Users can delete own units" on public.units;

alter table public.properties
  drop column if exists user_id;

drop index if exists properties_user_id_idx;

alter table public.vendors
  add column if not exists team_id uuid;

update public.vendors
set team_id = teams.id
from public.teams
where teams.owner_user_id = vendors.user_id
  and vendors.team_id is null;

alter table public.vendors
  alter column team_id set not null;

alter table public.vendors
  add constraint vendors_team_id_fkey
  foreign key (team_id) references public.teams(id) on delete cascade;

create index if not exists vendors_team_id_idx
  on public.vendors(team_id);

drop policy if exists "Users can view own vendors" on public.vendors;
drop policy if exists "Users can insert own vendors" on public.vendors;
drop policy if exists "Users can update own vendors" on public.vendors;
drop policy if exists "Users can delete own vendors" on public.vendors;

alter table public.vendors
  drop column if exists user_id;

drop index if exists vendors_user_id_idx;

create table if not exists public.owners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  name text not null,
  email text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.property_owners (
  property_id uuid not null references public.properties(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint property_owners_pkey primary key (property_id, owner_id)
);

alter table if exists public.actions
  rename to tasks;

alter index if exists actions_user_id_idx
  rename to tasks_user_id_idx;

alter index if exists actions_issue_id_idx
  rename to tasks_issue_id_idx;

alter index if exists actions_status_idx
  rename to tasks_status_idx;

alter index if exists actions_action_type_idx
  rename to tasks_action_type_idx;

alter table public.tasks
  add column if not exists team_id uuid;

alter table public.tasks
  add column if not exists created_by uuid;

alter table public.tasks
  add column if not exists leader_id uuid;

alter table public.tasks
  add column if not exists approved_by uuid;

alter table public.tasks
  add column if not exists approved_at timestamptz;

update public.tasks
set created_by = user_id
where created_by is null;

update public.tasks
set team_id = teams.id
from public.teams
where teams.owner_user_id = tasks.user_id
  and tasks.team_id is null;

alter table public.tasks
  add constraint tasks_team_id_fkey
  foreign key (team_id) references public.teams(id) on delete cascade;

alter table public.tasks
  add constraint tasks_created_by_fkey
  foreign key (created_by) references public.users(id) on delete set null;

alter table public.tasks
  add constraint tasks_leader_id_fkey
  foreign key (leader_id) references public.users(id) on delete set null;

alter table public.tasks
  add constraint tasks_approved_by_fkey
  foreign key (approved_by) references public.users(id) on delete set null;

create index if not exists tasks_team_id_idx
  on public.tasks(team_id);

create index if not exists tasks_created_by_idx
  on public.tasks(created_by);

create index if not exists tasks_leader_id_idx
  on public.tasks(leader_id);

drop policy if exists "Users can view own actions" on public.tasks;
drop policy if exists "Users can insert own actions" on public.tasks;
drop policy if exists "Users can update own actions" on public.tasks;
drop policy if exists "Users can delete own actions" on public.tasks;

alter table public.tasks
  drop constraint if exists actions_user_id_fkey;

alter table public.tasks
  drop column if exists user_id;

drop index if exists tasks_user_id_idx;

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.owners enable row level security;
alter table public.property_owners enable row level security;
alter table public.properties enable row level security;
alter table public.units enable row level security;
alter table public.tenants enable row level security;
alter table public.issues enable row level security;
alter table public.threads enable row level security;
alter table public.messages enable row level security;
alter table public.vendors enable row level security;
alter table public.tasks enable row level security;

drop policy if exists "Users can view own buildings" on public.properties;
drop policy if exists "Users can insert own buildings" on public.properties;
drop policy if exists "Users can update own buildings" on public.properties;
drop policy if exists "Users can delete own buildings" on public.properties;

drop policy if exists "Users can view own units" on public.units;
drop policy if exists "Users can insert own units" on public.units;
drop policy if exists "Users can update own units" on public.units;
drop policy if exists "Users can delete own units" on public.units;

drop policy if exists "Users can view own tenants" on public.tenants;
drop policy if exists "Users can insert own tenants" on public.tenants;
drop policy if exists "Users can update own tenants" on public.tenants;
drop policy if exists "Users can delete own tenants" on public.tenants;

drop policy if exists "Users can view own issues" on public.issues;
drop policy if exists "Users can insert own issues" on public.issues;
drop policy if exists "Users can update own issues" on public.issues;
drop policy if exists "Users can delete own issues" on public.issues;

drop policy if exists "Users can view own threads" on public.threads;
drop policy if exists "Users can insert own threads" on public.threads;
drop policy if exists "Users can update own threads" on public.threads;
drop policy if exists "Users can delete own threads" on public.threads;

drop policy if exists "Users can view own messages" on public.messages;
drop policy if exists "Users can insert own messages" on public.messages;
drop policy if exists "Users can update own messages" on public.messages;
drop policy if exists "Users can delete own messages" on public.messages;

drop policy if exists "Users can view own vendors" on public.vendors;
drop policy if exists "Users can insert own vendors" on public.vendors;
drop policy if exists "Users can update own vendors" on public.vendors;
drop policy if exists "Users can delete own vendors" on public.vendors;

drop policy if exists "Users can view own actions" on public.tasks;
drop policy if exists "Users can insert own actions" on public.tasks;
drop policy if exists "Users can update own actions" on public.tasks;
drop policy if exists "Users can delete own actions" on public.tasks;

create policy "Team members can view teams"
  on public.teams for select
  using (
    exists (
      select 1
      from public.team_members
      where team_members.team_id = teams.id
        and team_members.user_id = auth.uid()
    )
  );

create policy "Owners can create teams"
  on public.teams for insert
  with check (owner_user_id = auth.uid());

create policy "Admins can update teams"
  on public.teams for update
  using (
    exists (
      select 1
      from public.team_members
      where team_members.team_id = teams.id
        and team_members.user_id = auth.uid()
        and team_members.role = 'admin'
    )
  );

create policy "Team members can view memberships"
  on public.team_members for select
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = team_members.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Admins can manage memberships"
  on public.team_members for insert
  with check (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = team_members.team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
    )
  );

create policy "Admins can update memberships"
  on public.team_members for update
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = team_members.team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = team_members.team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
    )
  );

create policy "Admins can delete memberships"
  on public.team_members for delete
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = team_members.team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
    )
  );

create policy "Team members can view properties"
  on public.properties for select
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = properties.team_id
        and tm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.property_owners po
      join public.owners o on o.id = po.owner_id
      where po.property_id = properties.id
        and o.user_id = auth.uid()
    )
  );

create policy "Team members can insert properties"
  on public.properties for insert
  with check (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = properties.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can update properties"
  on public.properties for update
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = properties.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can delete properties"
  on public.properties for delete
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = properties.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can view units"
  on public.units for select
  using (
    exists (
      select 1
      from public.properties p
      join public.team_members tm on tm.team_id = p.team_id
      where p.id = units.property_id
        and tm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.property_owners po
      join public.owners o on o.id = po.owner_id
      where po.property_id = units.property_id
        and o.user_id = auth.uid()
    )
  );

create policy "Team members can insert units"
  on public.units for insert
  with check (
    exists (
      select 1
      from public.properties p
      join public.team_members tm on tm.team_id = p.team_id
      where p.id = units.property_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can update units"
  on public.units for update
  using (
    exists (
      select 1
      from public.properties p
      join public.team_members tm on tm.team_id = p.team_id
      where p.id = units.property_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can delete units"
  on public.units for delete
  using (
    exists (
      select 1
      from public.properties p
      join public.team_members tm on tm.team_id = p.team_id
      where p.id = units.property_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can view tenants"
  on public.tenants for select
  using (
    exists (
      select 1
      from public.units u
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where u.id = tenants.unit_id
        and tm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.units u
      join public.property_owners po on po.property_id = u.property_id
      join public.owners o on o.id = po.owner_id
      where u.id = tenants.unit_id
        and o.user_id = auth.uid()
    )
  );

create policy "Team members can insert tenants"
  on public.tenants for insert
  with check (
    exists (
      select 1
      from public.units u
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where u.id = tenants.unit_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can update tenants"
  on public.tenants for update
  using (
    exists (
      select 1
      from public.units u
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where u.id = tenants.unit_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can delete tenants"
  on public.tenants for delete
  using (
    exists (
      select 1
      from public.units u
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where u.id = tenants.unit_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can view issues"
  on public.issues for select
  using (
    exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where t.id = issues.tenant_id
        and tm.user_id = auth.uid()
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

create policy "Team members can insert issues"
  on public.issues for insert
  with check (
    exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where t.id = issues.tenant_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can update issues"
  on public.issues for update
  using (
    exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where t.id = issues.tenant_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can delete issues"
  on public.issues for delete
  using (
    exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where t.id = issues.tenant_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can view threads"
  on public.threads for select
  using (
    exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where t.id = threads.tenant_id
        and tm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.property_owners po on po.property_id = u.property_id
      join public.owners o on o.id = po.owner_id
      where t.id = threads.tenant_id
        and o.user_id = auth.uid()
    )
  );

create policy "Team members can insert threads"
  on public.threads for insert
  with check (
    exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where t.id = threads.tenant_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can update threads"
  on public.threads for update
  using (
    exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where t.id = threads.tenant_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can delete threads"
  on public.threads for delete
  using (
    exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where t.id = threads.tenant_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can view messages"
  on public.messages for select
  using (
    exists (
      select 1
      from public.threads th
      join public.tenants t on t.id = th.tenant_id
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where th.id = messages.thread_id
        and tm.user_id = auth.uid()
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

create policy "Team members can insert messages"
  on public.messages for insert
  with check (
    exists (
      select 1
      from public.threads th
      join public.tenants t on t.id = th.tenant_id
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where th.id = messages.thread_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can update messages"
  on public.messages for update
  using (
    exists (
      select 1
      from public.threads th
      join public.tenants t on t.id = th.tenant_id
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where th.id = messages.thread_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can delete messages"
  on public.messages for delete
  using (
    exists (
      select 1
      from public.threads th
      join public.tenants t on t.id = th.tenant_id
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where th.id = messages.thread_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can view vendors"
  on public.vendors for select
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = vendors.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can insert vendors"
  on public.vendors for insert
  with check (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = vendors.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can update vendors"
  on public.vendors for update
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = vendors.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can delete vendors"
  on public.vendors for delete
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = vendors.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can view tasks"
  on public.tasks for select
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = tasks.team_id
        and tm.user_id = auth.uid()
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

create policy "Team members can insert tasks"
  on public.tasks for insert
  with check (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = tasks.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can update tasks"
  on public.tasks for update
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = tasks.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can delete tasks"
  on public.tasks for delete
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = tasks.team_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can view owners"
  on public.owners for select
  using (
    exists (
      select 1
      from public.property_owners po
      join public.properties p on p.id = po.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where po.owner_id = owners.id
        and tm.user_id = auth.uid()
    )
    or owners.user_id = auth.uid()
  );

create policy "Team members can insert owners"
  on public.owners for insert
  with check (
    exists (
      select 1
      from public.team_members tm
      where tm.user_id = auth.uid()
    )
    or owners.user_id = auth.uid()
  );

create policy "Team members can update owners"
  on public.owners for update
  using (
    exists (
      select 1
      from public.property_owners po
      join public.properties p on p.id = po.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where po.owner_id = owners.id
        and tm.user_id = auth.uid()
    )
    or owners.user_id = auth.uid()
  );

create policy "Team members can delete owners"
  on public.owners for delete
  using (
    exists (
      select 1
      from public.property_owners po
      join public.properties p on p.id = po.property_id
      join public.team_members tm on tm.team_id = p.team_id
      where po.owner_id = owners.id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can view property owners"
  on public.property_owners for select
  using (
    exists (
      select 1
      from public.properties p
      join public.team_members tm on tm.team_id = p.team_id
      where p.id = property_owners.property_id
        and tm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.owners o
      where o.id = property_owners.owner_id
        and o.user_id = auth.uid()
    )
  );

create policy "Team members can insert property owners"
  on public.property_owners for insert
  with check (
    exists (
      select 1
      from public.properties p
      join public.team_members tm on tm.team_id = p.team_id
      where p.id = property_owners.property_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can update property owners"
  on public.property_owners for update
  using (
    exists (
      select 1
      from public.properties p
      join public.team_members tm on tm.team_id = p.team_id
      where p.id = property_owners.property_id
        and tm.user_id = auth.uid()
    )
  );

create policy "Team members can delete property owners"
  on public.property_owners for delete
  using (
    exists (
      select 1
      from public.properties p
      join public.team_members tm on tm.team_id = p.team_id
      where p.id = property_owners.property_id
        and tm.user_id = auth.uid()
    )
  );
