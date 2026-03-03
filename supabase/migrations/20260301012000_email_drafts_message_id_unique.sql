drop index if exists email_drafts_message_id_idx;
drop index if exists email_drafts_message_id_unique;

create unique index email_drafts_message_id_unique
  on public.email_drafts (message_id);

create unique index if not exists email_drafts_issue_id_message_id_null_idx
  on public.email_drafts (issue_id)
  where message_id is null;
