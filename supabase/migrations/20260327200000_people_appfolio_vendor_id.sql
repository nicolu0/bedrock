-- Add appfolio_vendor_id to people so AppFolio vendors can be synced without duplicates
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS appfolio_vendor_id text;

ALTER TABLE public.people
  ADD CONSTRAINT people_appfolio_vendor_id_workspace_unique
  UNIQUE (workspace_id, appfolio_vendor_id);
