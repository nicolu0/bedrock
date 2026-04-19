-- Backfill Schedule drafts recipient from the root issue vendor
--
-- The UI vendor selector is on Schedule drafts. If an issue already has a vendor assigned
-- (stored on the *root* issue as issues.vendor_id), ensure any Schedule drafts under that
-- issue have their recipient_email(s) set to the vendor email so the selector shows the
-- correct vendor by default.

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
schedule_drafts AS (
  SELECT
    d.id AS draft_id,
    t.workspace_id,
    r.vendor_id,
    v.email AS vendor_email
  FROM public.drafts d
  JOIN issue_tree t ON t.id = d.issue_id
  JOIN public.issues i ON i.id = d.issue_id
  JOIN public.issues r ON r.id = t.root_id
  JOIN public.vendors v ON v.id = r.vendor_id
  WHERE i.name ~* '^schedule\s+'
    AND r.vendor_id IS NOT NULL
    AND v.email IS NOT NULL
    AND (
      (d.recipient_email IS NULL OR btrim(d.recipient_email) = '')
      AND (d.recipient_emails IS NULL OR array_length(d.recipient_emails, 1) IS NULL)
    )
)
UPDATE public.drafts d
SET
  recipient_email = sd.vendor_email,
  recipient_emails = ARRAY[sd.vendor_email],
  updated_at = now()
FROM schedule_drafts sd
WHERE d.id = sd.draft_id;
