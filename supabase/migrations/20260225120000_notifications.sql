-- A: Add issue_number to issues
ALTER TABLE issues ADD COLUMN IF NOT EXISTS issue_number INTEGER;

CREATE OR REPLACE FUNCTION set_issue_number()
RETURNS TRIGGER AS $$
BEGIN
  SELECT COALESCE(MAX(issue_number), 0) + 1
    INTO NEW.issue_number
    FROM issues
   WHERE workspace_id = NEW.workspace_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_issue_number ON issues;
CREATE TRIGGER trg_set_issue_number
BEFORE INSERT ON issues
FOR EACH ROW EXECUTE FUNCTION set_issue_number();

-- Backfill existing issues with sequential numbers per workspace
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at, id) AS rn
  FROM issues
  WHERE issue_number IS NULL
)
UPDATE issues
SET issue_number = numbered.rn
FROM numbered
WHERE issues.id = numbered.id;

-- B: Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id     UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  is_read      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users can read own notifications" ON notifications;
CREATE POLICY "users can read own notifications"
  ON notifications FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "users can update own notifications" ON notifications;
CREATE POLICY "users can update own notifications"
  ON notifications FOR UPDATE
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "service role can insert notifications" ON notifications;
CREATE POLICY "service role can insert notifications"
  ON notifications FOR INSERT
  WITH CHECK (true);
