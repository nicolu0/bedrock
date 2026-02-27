delete from public.messages m
using public.messages d
where m.external_id is not null
  and d.external_id = m.external_id
  and d.id < m.id;

delete from public.threads t
using public.threads d
where t.external_id is not null
  and d.external_id = t.external_id
  and d.id < t.id;

create unique index if not exists messages_external_id_unique
  on public.messages (external_id)
  where external_id is not null;

create unique index if not exists threads_external_id_unique
  on public.threads (external_id)
  where external_id is not null;
