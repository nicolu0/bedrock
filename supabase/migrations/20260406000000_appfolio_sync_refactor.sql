-- Incremental sync checkpoint and vendor ID accumulator on workspaces
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS last_work_order_sync_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_metadata_sync_at    timestamptz,
  ADD COLUMN IF NOT EXISTS appfolio_seen_vendor_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sync_property_cursor     integer NOT NULL DEFAULT 0;

-- Durable agent dispatch queue — replaces in-memory changeQueue
CREATE TABLE IF NOT EXISTS public.agent_dispatch_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  issue_id       uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  change_type    text NOT NULL,
  row_data       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  error          text
);

-- Dedup: only one unprocessed event per (issue_id, change_type)
CREATE UNIQUE INDEX IF NOT EXISTS agent_dispatch_queue_dedup_idx
  ON public.agent_dispatch_queue (issue_id, change_type)
  WHERE processed_at IS NULL;

-- Pickup query: unprocessed events ordered by creation
CREATE INDEX IF NOT EXISTS agent_dispatch_queue_pending_idx
  ON public.agent_dispatch_queue (workspace_id, created_at)
  WHERE processed_at IS NULL;

ALTER TABLE public.agent_dispatch_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on agent_dispatch_queue"
  ON public.agent_dispatch_queue FOR ALL
  USING (true) WITH CHECK (true);

-- Cron schedules (substitute PROJECT_REF and SERVICE_ROLE_KEY before running):
--
-- Fast path: every minute (work orders + agent dispatch)
-- select cron.schedule(
--   'appfolio-sync-fast',
--   '* * * * *',
--   $$
--     select net.http_post(
--       url := 'https://{PROJECT_REF}.supabase.co/functions/v1/appfolio-sync',
--       headers := '{"Content-Type":"application/json","Authorization":"Bearer {SERVICE_ROLE_KEY}"}'::jsonb,
--       body := '{}'::jsonb
--     );
--   $$
-- );
--
-- Slow path: every 6 hours (properties, units, tenants, vendors)
-- select cron.schedule(
--   'appfolio-sync-metadata',
--   '0 */6 * * *',
--   $$
--     select net.http_post(
--       url := 'https://{PROJECT_REF}.supabase.co/functions/v1/appfolio-sync?mode=metadata',
--       headers := '{"Content-Type":"application/json","Authorization":"Bearer {SERVICE_ROLE_KEY}"}'::jsonb,
--       body := '{}'::jsonb
--     );
--   $$
-- );
