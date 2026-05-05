-- Wipe issues_v2 ingestion state and rename appfolio_id → appfolio_srn.
--
-- Pre-deploy of intake-agent v8, two earlier code paths wrote different
-- numeric spaces into `appfolio_id`: the legacy path stored AppFolio's
-- internal work_order_id, while the new path stores service_request_number
-- (the number visible in the WO email subject like "WO #7627-1"). The two
-- sequences collide at random, so existing rows are not safe to reconcile —
-- truncate and let the pipeline rebuild from scratch.

truncate table public.issues_v2 restart identity cascade;
truncate table public.gmail_message_dedup;

drop index if exists public.issues_v2_workspace_appfolio_id_unique;

alter table public.issues_v2 rename column appfolio_id to appfolio_srn;

create unique index issues_v2_workspace_appfolio_srn_unique
  on public.issues_v2 (workspace_id, appfolio_srn)
  where appfolio_srn is not null;
