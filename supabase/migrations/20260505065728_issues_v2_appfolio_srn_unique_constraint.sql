-- Replace the partial unique index on (workspace_id, appfolio_srn) with a real
-- unique constraint. Postgres won't infer ON CONFLICT from a partial unique
-- index, so the intake-agent upsert was failing with "no unique or exclusion
-- constraint matching the ON CONFLICT specification". A full constraint also
-- gives us a real catalog entry rather than just a unique index.

drop index if exists public.issues_v2_workspace_appfolio_srn_unique;

alter table public.issues_v2
  add constraint issues_v2_workspace_appfolio_srn_unique
  unique (workspace_id, appfolio_srn);
