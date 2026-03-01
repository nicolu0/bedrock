alter table public.email_drafts
  add column if not exists message_id uuid references public.messages(id) on delete cascade;

drop index if exists email_drafts_issue_id_idx;
create index if not exists email_drafts_issue_id_idx on public.email_drafts (issue_id);

create unique index if not exists email_drafts_message_id_idx
  on public.email_drafts (message_id)
  where message_id is not null;
