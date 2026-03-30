-- Performance indexes: fix sequential scans causing disk IO spike.
--
-- Root causes identified via pg_stat_user_tables:
--   people:        5.2M seq scans (77M tuples read) — no index on role column
--   notifications: 16K seq scans   — only pkey index exists
--
-- people(workspace_id, role): used by agent post-loop and any query that
-- filters bedrock users (WHERE workspace_id = X AND role = 'bedrock').
CREATE INDEX IF NOT EXISTS people_workspace_role_idx
  ON public.people(workspace_id, role);

-- notifications: queried by workspace, user, and issue — none indexed.
CREATE INDEX IF NOT EXISTS notifications_workspace_id_idx
  ON public.notifications(workspace_id);

CREATE INDEX IF NOT EXISTS notifications_user_id_idx
  ON public.notifications(user_id);

CREATE INDEX IF NOT EXISTS notifications_issue_id_idx
  ON public.notifications(issue_id);
