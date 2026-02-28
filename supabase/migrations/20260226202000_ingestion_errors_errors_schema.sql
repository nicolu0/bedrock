create schema if not exists errors;

create table if not exists errors.ingestion_errors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  source text not null,
  detail text not null,
  created_at timestamptz not null default now()
);

create index if not exists ingestion_errors_user_id_idx on errors.ingestion_errors (user_id);
create index if not exists ingestion_errors_source_idx on errors.ingestion_errors (source);
