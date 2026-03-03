alter table public.vendors
  add column if not exists trade text,
  add column if not exists note  text;
