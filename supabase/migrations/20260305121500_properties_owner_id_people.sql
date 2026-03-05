alter table public.properties
  drop constraint if exists properties_owner_id_fkey;

update public.properties p
set owner_id = pe.id
from public.people pe
where pe.user_id = p.owner_id;

update public.properties
set owner_id = null
where owner_id is not null
  and not exists (select 1 from public.people pe where pe.id = properties.owner_id);

alter table public.properties
  add constraint properties_owner_id_fkey
  foreign key (owner_id) references public.people(id) on delete set null;
