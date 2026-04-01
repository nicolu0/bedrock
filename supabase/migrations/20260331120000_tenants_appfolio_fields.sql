-- Add phone and appfolio_tenant_id to tenants.
-- Full (non-partial) unique index on (unit_id, email) enables upsert via onConflict.
-- Supabase PostgREST requires a non-partial unique index to match ON CONFLICT specs.
-- PostgreSQL treats NULLs as distinct in unique indexes, so multiple NULL emails
-- for the same unit_id are allowed without violating uniqueness.
-- appfolio_tenant_id stored as metadata for future use but not the conflict key,
-- since AppFolio's tenant_directory report does not expose a tenant_id field.
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS appfolio_tenant_id text;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_unit_id_email_unique
  ON public.tenants (unit_id, email);
