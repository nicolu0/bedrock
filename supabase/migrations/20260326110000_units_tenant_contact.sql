-- Add primary tenant contact fields to units, populated by AppFolio tenant_directory sync.
ALTER TABLE public.units
  ADD COLUMN IF NOT EXISTS tenant_name text,
  ADD COLUMN IF NOT EXISTS tenant_email text,
  ADD COLUMN IF NOT EXISTS tenant_phone text;
