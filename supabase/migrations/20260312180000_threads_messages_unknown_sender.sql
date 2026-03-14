alter table public.threads
  drop constraint if exists threads_participant_type_check;

update public.threads
set participant_type = 'unknown'
where participant_type is null
  or participant_type not in ('tenant', 'vendor', 'unknown');

alter table public.threads
  add constraint threads_participant_type_check
  check (participant_type in ('tenant', 'vendor', 'unknown'));

alter table public.messages
  drop constraint if exists messages_sender_check;

update public.messages
set sender = 'unknown'
where sender is null
  or sender not in ('tenant', 'vendor', 'unknown');

alter table public.messages
  add constraint messages_sender_check
  check (sender in ('tenant', 'vendor', 'unknown'));
