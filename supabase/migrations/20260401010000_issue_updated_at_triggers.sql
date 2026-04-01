-- Keep issues.updated_at fresh for any issue changes
CREATE OR REPLACE FUNCTION set_issue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_issue_updated_at ON issues;
CREATE TRIGGER trg_set_issue_updated_at
BEFORE UPDATE ON issues
FOR EACH ROW EXECUTE FUNCTION set_issue_updated_at();

-- Touch parent issue when activity logs are added
CREATE OR REPLACE FUNCTION touch_issue_on_activity_log_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.issue_id IS NOT NULL THEN
    UPDATE issues SET updated_at = now() WHERE id = NEW.issue_id;
    UPDATE issues
      SET updated_at = now()
      WHERE id = (SELECT parent_id FROM issues WHERE id = NEW.issue_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_issue_on_activity_log_insert ON activity_logs;
CREATE TRIGGER trg_touch_issue_on_activity_log_insert
AFTER INSERT OR UPDATE ON activity_logs
FOR EACH ROW EXECUTE FUNCTION touch_issue_on_activity_log_insert();

-- Touch issue when drafts are created/updated
CREATE OR REPLACE FUNCTION touch_issue_on_draft_write()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.issue_id IS NOT NULL THEN
    UPDATE issues SET updated_at = now() WHERE id = NEW.issue_id;
    UPDATE issues
      SET updated_at = now()
      WHERE id = (SELECT parent_id FROM issues WHERE id = NEW.issue_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Touch parent issue when a subissue is updated
CREATE OR REPLACE FUNCTION touch_parent_issue_on_issue_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    UPDATE issues SET updated_at = now() WHERE id = NEW.parent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_parent_issue_on_issue_update ON issues;
CREATE TRIGGER trg_touch_parent_issue_on_issue_update
AFTER UPDATE ON issues
FOR EACH ROW EXECUTE FUNCTION touch_parent_issue_on_issue_update();

DROP TRIGGER IF EXISTS trg_touch_issue_on_draft_write ON drafts;
CREATE TRIGGER trg_touch_issue_on_draft_write
AFTER INSERT OR UPDATE ON drafts
FOR EACH ROW EXECUTE FUNCTION touch_issue_on_draft_write();

-- Touch issue when messages are created
CREATE OR REPLACE FUNCTION touch_issue_on_message_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.issue_id IS NOT NULL THEN
    UPDATE issues SET updated_at = now() WHERE id = NEW.issue_id;
    UPDATE issues
      SET updated_at = now()
      WHERE id = (SELECT parent_id FROM issues WHERE id = NEW.issue_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_issue_on_message_insert ON messages;
CREATE TRIGGER trg_touch_issue_on_message_insert
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION touch_issue_on_message_insert();
