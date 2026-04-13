-- Workspace-level toggle for policy learning UI (tone + automation prompts)

alter table public.workspaces
  add column if not exists policy_learning_enabled boolean not null default false;
