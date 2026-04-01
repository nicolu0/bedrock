-- Replace (unit_id, email) unique index with (unit_id, email, name) so tenants
-- without email can be deduped by name within the same unit.
-- NULLS NOT DISTINCT (PostgreSQL 15+) treats NULL = NULL for uniqueness:
--   (unit_id, NULL email, "John Doe") conflicts with another (unit_id, NULL, "John Doe").
--   (unit_id, NULL email, "Jane Doe") does NOT conflict — different name.
-- This lets a single upsert path handle both email and no-email tenants.
DROP INDEX IF EXISTS public.tenants_unit_id_email_unique;

CREATE UNIQUE INDEX tenants_unit_id_email_name_unique
  ON public.tenants (unit_id, email, name) NULLS NOT DISTINCT;
