create unique index if not exists email_drafts_issue_id_message_id_null_idx
  on public.email_drafts (issue_id)
  where message_id is null;
