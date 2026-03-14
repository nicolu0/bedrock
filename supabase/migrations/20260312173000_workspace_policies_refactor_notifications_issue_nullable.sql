alter table public.workspace_policies
  add column if not exists id uuid default gen_random_uuid();

update public.workspace_policies
set id = gen_random_uuid()
where id is null;

alter table public.workspace_policies
  alter column id set not null;

alter table public.workspace_policies
  drop constraint if exists workspace_policies_pkey;

alter table public.workspace_policies
  add constraint workspace_policies_pkey primary key (id);

alter table public.workspace_policies
  add column if not exists type text not null default 'behavior',
  add column if not exists email text,
  add column if not exists description text,
  add column if not exists meta jsonb,
  add column if not exists created_by uuid references public.users(id) on delete set null,
  add column if not exists created_at timestamptz not null default now();

create index if not exists workspace_policies_workspace_id_idx
  on public.workspace_policies (workspace_id);

create index if not exists workspace_policies_workspace_type_email_idx
  on public.workspace_policies (workspace_id, type, email);

alter table public.notifications
  alter column issue_id drop not null;
