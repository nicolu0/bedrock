-- V2 schema: clean issues table, per-(issue,agent) run tracking, gmail message dedup.

-- ── issues_v2 ────────────────────────────────────────────────────────────────
CREATE TABLE public.issues_v2 (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  appfolio_id   text,
  unit_id       uuid        REFERENCES public.units(id) ON DELETE SET NULL,
  property_id   uuid        REFERENCES public.properties(id) ON DELETE SET NULL,
  tenant_id     uuid        REFERENCES public.tenants(id) ON DELETE SET NULL,
  vendor_id     uuid        REFERENCES public.vendors(id) ON DELETE SET NULL,
  description   text,
  name          text,
  urgent        boolean
);

CREATE UNIQUE INDEX issues_v2_workspace_appfolio_id_unique
  ON public.issues_v2 (workspace_id, appfolio_id)
  WHERE appfolio_id IS NOT NULL;

CREATE INDEX issues_v2_workspace_created_idx
  ON public.issues_v2 (workspace_id, created_at DESC);

ALTER TABLE public.issues_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY "issues_v2 read by workspace members" ON public.issues_v2
  FOR SELECT USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

CREATE POLICY "issues_v2 admins can write" ON public.issues_v2
  FOR ALL USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

-- ── agent_runs ───────────────────────────────────────────────────────────────
-- One row per (issue × agent_name × attempt). Tracks lifecycle of each agent
-- invocation. Macmini polls `done` rows to decide when to draft iMessage.
CREATE TABLE public.agent_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id        uuid        NOT NULL REFERENCES public.issues_v2(id) ON DELETE CASCADE,
  agent_name      text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  started_at      timestamptz,
  completed_at    timestamptz,
  error           text,
  attempt_count   integer     NOT NULL DEFAULT 0,
  run_id          uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runs_status_check CHECK (status IN ('pending', 'processing', 'done', 'failed'))
);

-- One run row per (issue, agent). claim_agent_run mutates this row in place.
CREATE UNIQUE INDEX agent_runs_issue_agent_unique
  ON public.agent_runs (issue_id, agent_name);

CREATE INDEX agent_runs_pending_idx
  ON public.agent_runs (status)
  WHERE status = 'pending';

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_runs read by workspace members" ON public.agent_runs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.issues_v2 i
      WHERE i.id = agent_runs.issue_id
        AND lower(current_people_role(i.workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
    )
  );

-- ── claim_agent_run RPC ──────────────────────────────────────────────────────
-- Atomic claim: mark a pending/failed/stale-processing run as 'processing' and
-- return its run_id. Returns null if nothing to claim (already done or being
-- processed by a fresh worker).
CREATE OR REPLACE FUNCTION public.claim_agent_run(
  p_issue_id      uuid,
  p_agent_name    text,
  p_stale_minutes integer DEFAULT 15
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_run_id uuid := gen_random_uuid();
  claimed_run_id uuid;
BEGIN
  UPDATE public.agent_runs
  SET
    status = 'processing',
    started_at = now(),
    attempt_count = attempt_count + 1,
    run_id = new_run_id,
    error = NULL
  WHERE issue_id = p_issue_id
    AND agent_name = p_agent_name
    AND (
      status IN ('pending', 'failed')
      OR (status = 'processing'
          AND started_at < now() - (p_stale_minutes || ' minutes')::interval)
    )
  RETURNING run_id INTO claimed_run_id;

  RETURN claimed_run_id;
END;
$$;

-- ── gmail_message_dedup ──────────────────────────────────────────────────────
-- Atomic per-message dedup. intake-v2 inserts message_id at the top of the
-- handler; on conflict, the message has already been processed and intake
-- bails. Eliminates duplicate work from at-least-once Pub/Sub delivery.
CREATE TABLE public.gmail_message_dedup (
  message_id   text         PRIMARY KEY,
  processed_at timestamptz  NOT NULL DEFAULT now(),
  issue_id     uuid         REFERENCES public.issues_v2(id) ON DELETE SET NULL
);

CREATE INDEX gmail_message_dedup_processed_at_idx
  ON public.gmail_message_dedup (processed_at);
