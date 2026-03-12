alter table public.invites
  add column if not exists people_id uuid;

alter table public.invites
  add constraint invites_people_id_fkey
  foreign key (people_id) references public.people(id) on delete set null;

create index if not exists invites_people_id_idx
  on public.invites(people_id);
