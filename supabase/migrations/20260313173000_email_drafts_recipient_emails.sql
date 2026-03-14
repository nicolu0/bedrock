alter table public.email_drafts
add column if not exists recipient_emails text[];

update public.email_drafts
set recipient_emails = (
  select array_agg(trim(part))
  from unnest(regexp_split_to_array(recipient_email, ',')) as part
  where trim(part) <> ''
)
where recipient_emails is null
  and recipient_email is not null;
