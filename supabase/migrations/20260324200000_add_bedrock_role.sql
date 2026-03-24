do $$
declare
  role_type text;
  role_schema text;
  is_enum boolean;
begin
  select t.typname, n.nspname
    into role_type, role_schema
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace cn on cn.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  join pg_namespace n on n.oid = t.typnamespace
  where cn.nspname = 'public'
    and c.relname = 'people'
    and a.attname = 'role'
    and a.attnum > 0
    and not a.attisdropped
  limit 1;

  if role_type is null then
    return;
  end if;

  select t.typtype = 'e'
    into is_enum
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  where t.typname = role_type
    and n.nspname = role_schema;

  if is_enum then
    execute format('alter type %I.%I add value if not exists %L', role_schema, role_type, 'bedrock');
  end if;
end $$;
