-- Drop the vestigial tenants.user_id column (multi-tenant cleanup; unblocks the
-- Green Oak crawler's tenant load).
--
-- Context: user_id was a NOT NULL FK -> users(id) written only by the legacy
-- appfolio-sync edge function, which is retired (not scheduled, 0 invocations).
-- No live code path writes or reads tenants.user_id: RLS scopes tenants via
-- unit_id joins, workspace scoping is via units, and nothing else (policy, index,
-- view, FK) references the column. Confirmed nullable in 20260601120000 first so
-- the crawler could insert tenants immediately; this completes the removal.
alter table public.tenants drop column if exists user_id;
