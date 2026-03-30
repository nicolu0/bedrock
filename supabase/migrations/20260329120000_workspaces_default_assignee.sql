-- Per-workspace default assignee override.
-- When set, the agent uses this user as the fallback assignee instead of admin_user_id.
-- Allows assigning all new issues to a specific person without changing workspace ownership.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS default_assignee_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
