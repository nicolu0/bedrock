-- Backfill issues.vendor_id from existing draft recipient selections
--
-- We store vendor assignment on the *root* issue, even when the draft is on a subissue.
-- This migration finds the most recently-updated draft (email or appfolio) with a
-- single recipient, matches that recipient email to a vendor in the same workspace,
-- and writes vendor_id onto the root issue when vendor_id is currently NULL.

WITH RECURSIVE issue_tree AS (
  SELECT
    i.id,
    i.workspace_id,
    i.parent_id,
    i.id AS root_id
  FROM public.issues i
  WHERE i.parent_id IS NULL

  UNION ALL

  SELECT
    c.id,
    c.workspace_id,
    c.parent_id,
    p.root_id
  FROM public.issues c
  JOIN issue_tree p ON c.parent_id = p.id
),
draft_candidates AS (
  SELECT
    t.root_id,
    t.workspace_id,
    d.updated_at,
    lower(
      coalesce(
        nullif(trim(d.recipient_email), ''),
        nullif(trim((d.recipient_emails)[1]), '')
      )
    ) AS recipient_email_norm
  FROM issue_tree t
  JOIN public.drafts d ON d.issue_id = t.id
  WHERE (
    (d.recipient_emails IS NOT NULL AND array_length(d.recipient_emails, 1) = 1)
    OR (d.recipient_email IS NOT NULL AND trim(d.recipient_email) <> '')
  )
),
latest_per_root AS (
  SELECT DISTINCT ON (c.root_id)
    c.root_id,
    c.workspace_id,
    c.recipient_email_norm,
    c.updated_at
  FROM draft_candidates c
  WHERE c.recipient_email_norm IS NOT NULL AND c.recipient_email_norm <> ''
  ORDER BY c.root_id, c.updated_at DESC
),
vendor_match AS (
  SELECT
    l.root_id,
    v.id AS vendor_id
  FROM latest_per_root l
  JOIN public.vendors v
    ON v.workspace_id = l.workspace_id
   AND lower(v.email) = l.recipient_email_norm
  WHERE v.email IS NOT NULL
)
UPDATE public.issues i
SET vendor_id = m.vendor_id
FROM vendor_match m
WHERE i.id = m.root_id
  AND i.vendor_id IS NULL;
