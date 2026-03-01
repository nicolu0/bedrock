alter table public.threads
  add column if not exists processing_at timestamptz;

create index if not exists threads_processing_at_idx
  on public.threads (processing_at);
