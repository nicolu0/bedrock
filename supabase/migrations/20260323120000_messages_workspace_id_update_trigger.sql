-- Backfill any messages that gained an issue_id without workspace_id
UPDATE messages m
SET workspace_id = i.workspace_id
FROM issues i
WHERE m.issue_id = i.id
  AND m.workspace_id IS NULL;

-- Ensure workspace_id is set when issue_id is added later
CREATE OR REPLACE FUNCTION set_message_workspace_id_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.workspace_id IS NULL AND NEW.issue_id IS NOT NULL THEN
    SELECT workspace_id INTO NEW.workspace_id FROM issues WHERE id = NEW.issue_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_message_workspace_id_update ON messages;
CREATE TRIGGER trg_message_workspace_id_update
BEFORE UPDATE ON messages
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL AND NEW.issue_id IS NOT NULL)
EXECUTE FUNCTION set_message_workspace_id_on_update();
