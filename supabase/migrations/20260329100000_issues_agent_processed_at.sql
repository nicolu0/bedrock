-- Track when the agent last cleaned an AppFolio issue's title/description.
-- NULL means the agent has never run (or failed). appfolio-sync re-queues stale NULLs.
ALTER TABLE public.issues
  ADD COLUMN IF NOT EXISTS agent_processed_at timestamptz;
