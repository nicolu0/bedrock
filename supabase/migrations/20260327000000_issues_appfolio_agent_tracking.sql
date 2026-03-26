-- Add change-tracking columns to issues for AppFolio agent loop.
-- These are populated by appfolio-sync and consumed by the agent edge function
-- to detect what changed and decide which agent actions to fire.
ALTER TABLE public.issues
  ADD COLUMN IF NOT EXISTS appfolio_raw_status    text,
  ADD COLUMN IF NOT EXISTS appfolio_status_notes  text,
  ADD COLUMN IF NOT EXISTS appfolio_vendor_id     text,
  ADD COLUMN IF NOT EXISTS vendor_assigned_at     timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_followup_sent   boolean NOT NULL DEFAULT false;

-- Add appfolio_note to the activity_logs type constraint so the agent can log
-- status_notes updates from AppFolio as structured activity entries.
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_type_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_type_check
  CHECK (type IN (
    'comment', 'status_change', 'assignee_change', 'email_outbound',
    'email_inbound', 'issue_created', 'appfolio_approved', 'appfolio_note'
  ));
