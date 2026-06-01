-- Work-order lifecycle status on issues_v2.
--
-- One status field the agent writes as it works the order from chat:
--   new → awaiting_pm → dispatched → scheduled → completed
--   with branches: triaging (gathering tenant info) and pm_handling (PM owns it).
--
-- Only `awaiting_pm` counts as a "candidate" the PM could be replying to. Every
-- PM reply must advance status out of awaiting_pm so answered WOs stop
-- resurfacing as phantom candidates (the "Yes, please → clarify" bug).
--
-- status_updated_at timestamps each change → drives follow-up staleness later.

ALTER TABLE public.issues_v2 ADD COLUMN status            text;
ALTER TABLE public.issues_v2 ADD COLUMN status_reason     text;
ALTER TABLE public.issues_v2 ADD COLUMN status_updated_at timestamptz;

-- One-time backfill: every existing WO → 'completed'. Clean slate so the
-- historical pile can never show up as an open candidate.
UPDATE public.issues_v2 SET status = 'completed', status_updated_at = now()
  WHERE status IS NULL;

-- Future inserts (poller/intake) land as 'new'; the agent moves them forward.
ALTER TABLE public.issues_v2 ALTER COLUMN status SET DEFAULT 'new';
ALTER TABLE public.issues_v2 ALTER COLUMN status SET NOT NULL;

ALTER TABLE public.issues_v2 ADD CONSTRAINT issues_v2_status_check
  CHECK (status IN ('new','triaging','awaiting_pm','dispatched','scheduled','pm_handling','completed'));

-- Candidate lookup: open WOs awaiting the PM's call, per workspace.
CREATE INDEX issues_v2_awaiting_pm_idx
  ON public.issues_v2 (workspace_id)
  WHERE status = 'awaiting_pm';
