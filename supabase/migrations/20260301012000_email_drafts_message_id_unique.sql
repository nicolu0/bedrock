drop index if exists email_drafts_message_id_idx;
drop index if exists email_drafts_message_id_unique;

create unique index email_drafts_message_id_unique
  on public.email_drafts (message_id);
