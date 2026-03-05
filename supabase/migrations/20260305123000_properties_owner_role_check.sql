create or replace function public.validate_property_owner_role()
returns trigger as $$
begin
  if new.owner_id is null then
    return new;
  end if;

  if not exists (
    select 1 from public.people p
    where p.id = new.owner_id
      and p.role = 'owner'
  ) then
    raise exception 'properties.owner_id must reference a person with role owner';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists properties_owner_role_check on public.properties;
create trigger properties_owner_role_check
before insert or update of owner_id on public.properties
for each row
execute function public.validate_property_owner_role();

create or replace function public.prevent_owner_role_downgrade()
returns trigger as $$
begin
  if old.role = 'owner' and new.role <> 'owner' then
    if exists (
      select 1 from public.properties p
      where p.owner_id = old.id
    ) then
      raise exception 'Cannot change role: person is assigned as a property owner';
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists people_owner_role_guard on public.people;
create trigger people_owner_role_guard
before update of role on public.people
for each row
execute function public.prevent_owner_role_downgrade();
