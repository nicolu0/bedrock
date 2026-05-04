alter table public.gmail_connections
  add column if not exists last_history_id   text,
  add column if not exists last_message_ts   bigint,
  add column if not exists watch_expires_at  timestamptz;

update public.gmail_connections gc
set last_history_id  = eis.last_history_id,
    last_message_ts  = eis.last_message_ts,
    watch_expires_at = eis.watch_expires_at
from public.email_ingestion_state eis
where eis.connection_id = gc.id;

drop table public.email_ingestion_state;
