create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_status_created_at_idx
  on public.jobs (status, created_at);

create unique index if not exists jobs_source_email_history_id_uniq
  on public.jobs (
    source,
    (payload->>'email'),
    (payload->>'history_id')
  );

alter table public.gmail_connections
  add column if not exists processing_at timestamptz;

create index if not exists gmail_connections_processing_at_idx
  on public.gmail_connections (processing_at);
