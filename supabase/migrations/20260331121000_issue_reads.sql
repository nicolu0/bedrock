CREATE TABLE IF NOT EXISTS issue_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issue_id, user_id)
);

CREATE INDEX IF NOT EXISTS issue_reads_issue_id_idx ON issue_reads(issue_id);
CREATE INDEX IF NOT EXISTS issue_reads_user_id_idx ON issue_reads(user_id);
CREATE INDEX IF NOT EXISTS issue_reads_workspace_id_idx ON issue_reads(workspace_id);

ALTER TABLE issue_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users can read own issue reads" ON issue_reads;
CREATE POLICY "users can read own issue reads"
  ON issue_reads FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "users can insert own issue reads" ON issue_reads;
CREATE POLICY "users can insert own issue reads"
  ON issue_reads FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users can update own issue reads" ON issue_reads;
CREATE POLICY "users can update own issue reads"
  ON issue_reads FOR UPDATE
  USING (user_id = auth.uid());
