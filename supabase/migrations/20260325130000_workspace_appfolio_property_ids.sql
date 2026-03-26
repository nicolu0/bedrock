-- Workspace-level filter for AppFolio property sync.
-- When set, only these AppFolio property IDs are synced for this workspace.
-- When null, all active properties are synced (not recommended for production).
alter table public.workspaces
  add column if not exists appfolio_property_ids text[];
