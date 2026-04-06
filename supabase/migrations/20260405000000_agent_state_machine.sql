-- 1a. State machine columns on issues table
ALTER TABLE public.issues
  ADD COLUMN IF NOT EXISTS agent_status        text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS agent_started_at    timestamptz,
  ADD COLUMN IF NOT EXISTS agent_completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS agent_error         text,
  ADD COLUMN IF NOT EXISTS agent_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS agent_run_id        uuid;

-- Add check constraint separately (IF NOT EXISTS not supported for constraints)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issues_agent_status_check'
  ) THEN
    ALTER TABLE public.issues
      ADD CONSTRAINT issues_agent_status_check
      CHECK (agent_status IN ('pending', 'processing', 'done', 'failed'));
  END IF;
END $$;

-- Backfill existing AppFolio issues
UPDATE public.issues
SET agent_status = CASE
      WHEN agent_processed_at IS NOT NULL THEN 'done'
      ELSE 'pending'
    END,
    agent_completed_at = agent_processed_at
WHERE source = 'appfolio';

-- Index for sync queries on agent_status
CREATE INDEX IF NOT EXISTS issues_agent_status_idx
  ON public.issues (workspace_id, source, agent_status)
  WHERE source = 'appfolio';

-- 1b. Subissue kind column + unique constraint for idempotency
ALTER TABLE public.issues
  ADD COLUMN IF NOT EXISTS subissue_kind text;

-- Backfill existing subissues by name pattern
UPDATE public.issues
SET subissue_kind = CASE
  WHEN name ~* '^triage\s+' THEN 'triage'
  WHEN name ~* '^schedule\s+' THEN 'schedule'
  ELSE NULL
END
WHERE parent_id IS NOT NULL;

-- DB-enforced uniqueness: one triage + one schedule per parent
CREATE UNIQUE INDEX IF NOT EXISTS issues_parent_subissue_kind_unique
  ON public.issues (parent_id, subissue_kind)
  WHERE parent_id IS NOT NULL AND subissue_kind IS NOT NULL;

-- 1c. Atomic claim RPC function
CREATE OR REPLACE FUNCTION public.claim_issue_for_agent(
  p_issue_id uuid,
  p_run_id uuid,
  p_stale_minutes integer DEFAULT 15
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rows_updated integer;
BEGIN
  UPDATE public.issues
  SET
    agent_status = 'processing',
    agent_started_at = now(),
    agent_attempt_count = agent_attempt_count + 1,
    agent_run_id = p_run_id
  WHERE id = p_issue_id
    AND (
      agent_status = 'pending'
      OR agent_status = 'failed'
      OR (agent_status = 'processing'
          AND agent_started_at < now() - (p_stale_minutes || ' minutes')::interval)
    );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END;
$$;
