create or replace function public.compute_issue_readable_id(unit_id uuid, issue_number integer)
returns text
language sql
as $$
  select case
    when issue_number is null then null
    when unit_id is null then 'ISSUE-' || issue_number::text
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

update public.issues
set readable_id = public.compute_issue_readable_id(unit_id, issue_number)
where readable_id is null;
