-- Replace partial unique index with a full unique constraint so that
-- ON CONFLICT (workspace_id, appfolio_owner_id) DO UPDATE works correctly.
-- PostgreSQL treats NULLs as distinct in UNIQUE constraints, so multiple
-- rows with appfolio_owner_id = NULL are still allowed.
DROP INDEX IF EXISTS public.owners_appfolio_id_workspace_unique;

ALTER TABLE public.owners
  ADD CONSTRAINT owners_workspace_appfolio_id_unique
  UNIQUE (workspace_id, appfolio_owner_id);
