-- Remove denormalized tenant contact fields from units.
-- Tenant data now lives in the tenants table (unit_id FK), populated by syncTenants().
ALTER TABLE public.units
  DROP COLUMN IF EXISTS tenant_name,
  DROP COLUMN IF EXISTS tenant_email,
  DROP COLUMN IF EXISTS tenant_phone;
