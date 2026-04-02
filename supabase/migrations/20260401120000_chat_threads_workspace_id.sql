alter table public.chat_threads
  add column if not exists workspace_id uuid null;

alter table public.chat_threads
  drop constraint if exists chat_threads_workspace_id_fkey;

alter table public.chat_threads
  add constraint chat_threads_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;

create index if not exists chat_threads_workspace_id_idx
  on public.chat_threads (workspace_id);

create unique index if not exists chat_threads_default_workspace_unique
  on public.chat_threads (user_id, workspace_id, is_default)
  where workspace_id is not null;

create unique index if not exists chat_threads_default_null_workspace_unique
  on public.chat_threads (user_id, is_default)
  where workspace_id is null;
