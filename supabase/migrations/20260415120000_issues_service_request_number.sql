-- Add service_request_number to issues for building AppFolio work order page URLs
alter table public.issues
  add column if not exists service_request_number text;
