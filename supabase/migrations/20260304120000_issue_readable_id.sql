alter table public.issues add column if not exists readable_id text;

create or replace function public.normalize_property_code(name text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(
      upper(left(split_part(regexp_replace(coalesce(name, ''), '[^a-z0-9]+', ' ', 'gi'), ' ', 1), 3)),
      ''
    ),
    'PROP'
  );
$$;

create or replace function public.normalize_unit_segment(name text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(coalesce(name, ''), '\s+', '', 'g'));
$$;

create or replace function public.compute_issue_readable_id(unit_id uuid, issue_number integer)
returns text
language sql
as $$
  select case
    when unit_id is null or issue_number is null then null
    else (
      select public.normalize_property_code(p.name)
        || '-' || public.normalize_unit_segment(u.name)
        || '-' || issue_number::text
      from public.units u
      join public.properties p on p.id = u.property_id
      where u.id = unit_id
    )
  end;
$$;

create or replace function public.set_issue_readable_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.readable_id := public.compute_issue_readable_id(new.unit_id, new.issue_number);
  return new;
end;
$$;

drop trigger if exists trg_set_issue_readable_id on public.issues;
create trigger trg_set_issue_readable_id
before insert or update of unit_id, issue_number
on public.issues
for each row
execute function public.set_issue_readable_id();

update public.issues
set readable_id = public.compute_issue_readable_id(unit_id, issue_number)
where readable_id is null;

create unique index if not exists issues_workspace_readable_id_key
on public.issues (workspace_id, readable_id);
