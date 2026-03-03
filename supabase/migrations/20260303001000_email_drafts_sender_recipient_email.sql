alter table public.email_drafts
  rename column sender to sender_email;

alter table public.email_drafts
  rename column recipient to recipient_email;
