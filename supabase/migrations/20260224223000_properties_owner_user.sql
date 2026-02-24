alter table public.properties
  add column if not exists owner_user_id uuid;

alter table public.properties
  add constraint properties_owner_user_id_fkey
  foreign key (owner_user_id) references public.users(id) on delete set null;

create index if not exists properties_owner_user_id_idx
  on public.properties(owner_user_id);

update public.properties p
set owner_user_id = o.user_id
from public.property_owners po
join public.owners o on o.id = po.owner_id
where po.property_id = p.id
  and o.user_id is not null
  and p.owner_user_id is null;

drop policy if exists "Workspace members can view properties" on public.properties;
drop policy if exists "Workspace members can insert properties" on public.properties;
drop policy if exists "Workspace members can update properties" on public.properties;
drop policy if exists "Workspace members can delete properties" on public.properties;

drop policy if exists "Workspace members can view units" on public.units;
drop policy if exists "Workspace members can insert units" on public.units;
drop policy if exists "Workspace members can update units" on public.units;
drop policy if exists "Workspace members can delete units" on public.units;

drop policy if exists "Workspace members can view tenants" on public.tenants;
drop policy if exists "Workspace members can insert tenants" on public.tenants;
drop policy if exists "Workspace members can update tenants" on public.tenants;
drop policy if exists "Workspace members can delete tenants" on public.tenants;

drop policy if exists "Workspace members can view issues" on public.issues;
drop policy if exists "Workspace members can insert issues" on public.issues;
drop policy if exists "Workspace members can update issues" on public.issues;
drop policy if exists "Workspace members can delete issues" on public.issues;

drop policy if exists "Workspace members can view threads" on public.threads;
drop policy if exists "Workspace members can insert threads" on public.threads;
drop policy if exists "Workspace members can update threads" on public.threads;
drop policy if exists "Workspace members can delete threads" on public.threads;

drop policy if exists "Workspace members can view messages" on public.messages;
drop policy if exists "Workspace members can insert messages" on public.messages;
drop policy if exists "Workspace members can update messages" on public.messages;
drop policy if exists "Workspace members can delete messages" on public.messages;

drop policy if exists "Workspace members can view vendors" on public.vendors;
drop policy if exists "Workspace members can insert vendors" on public.vendors;
drop policy if exists "Workspace members can update vendors" on public.vendors;
drop policy if exists "Workspace members can delete vendors" on public.vendors;

drop policy if exists "Workspace members can view tasks" on public.tasks;
drop policy if exists "Workspace members can insert tasks" on public.tasks;
drop policy if exists "Workspace members can update tasks" on public.tasks;
drop policy if exists "Workspace members can delete tasks" on public.tasks;

drop policy if exists "Workspace members can view owners" on public.owners;
drop policy if exists "Workspace members can insert owners" on public.owners;
drop policy if exists "Workspace members can update owners" on public.owners;
drop policy if exists "Workspace members can delete owners" on public.owners;

drop policy if exists "Workspace members can view property owners" on public.property_owners;
drop policy if exists "Workspace members can insert property owners" on public.property_owners;
drop policy if exists "Workspace members can update property owners" on public.property_owners;
drop policy if exists "Workspace members can delete property owners" on public.property_owners;

create policy "Workspace members can view properties"
  on public.properties for select
  using (
    exists (
      select 1
      from public.members m
      where m.workspace_id = properties.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('admin', 'member')
    )
    or properties.owner_user_id = auth.uid()
  );

create policy "Workspace members can insert properties"
  on public.properties for insert
  with check (
    exists (
      select 1
      from public.members m
      where m.workspace_id = properties.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.properties p
      where p.id = units.property_id
        and p.owner_user_id = auth.uid()
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.units u
      join public.properties p on p.id = u.property_id
      where u.id = tenants.unit_id
        and p.owner_user_id = auth.uid()
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      where t.id = issues.tenant_id
        and p.owner_user_id = auth.uid()
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.threads th
      join public.issues i on i.id = th.issue_id
      join public.tenants t on t.id = i.tenant_id
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      where th.id = threads.id
        and p.owner_user_id = auth.uid()
    )
    or exists (
      select 1
      from public.tenants t
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      where t.id = threads.tenant_id
        and p.owner_user_id = auth.uid()
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.threads th
      join public.issues i on i.id = th.issue_id
      join public.tenants t on t.id = i.tenant_id
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      where th.id = messages.thread_id
        and p.owner_user_id = auth.uid()
    )
    or exists (
      select 1
      from public.threads th
      join public.tenants t on t.id = th.tenant_id
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      where th.id = messages.thread_id
        and p.owner_user_id = auth.uid()
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.issues i
      join public.tenants t on t.id = i.tenant_id
      join public.units u on u.id = t.unit_id
      join public.properties p on p.id = u.property_id
      where i.id = tasks.issue_id
        and p.owner_user_id = auth.uid()
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
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
        and m.role in ('admin', 'member')
    )
  );

drop table if exists public.property_owners;
drop table if exists public.owners;
