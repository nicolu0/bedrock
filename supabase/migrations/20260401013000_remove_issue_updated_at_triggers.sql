-- Remove issue updated_at triggers
DROP TRIGGER IF EXISTS trg_set_issue_updated_at ON issues;
DROP FUNCTION IF EXISTS set_issue_updated_at();

DROP TRIGGER IF EXISTS trg_touch_issue_on_activity_log_insert ON activity_logs;
DROP FUNCTION IF EXISTS touch_issue_on_activity_log_insert();

DROP TRIGGER IF EXISTS trg_touch_issue_on_draft_write ON drafts;
DROP FUNCTION IF EXISTS touch_issue_on_draft_write();

DROP TRIGGER IF EXISTS trg_touch_issue_on_message_insert ON messages;
DROP FUNCTION IF EXISTS touch_issue_on_message_insert();

DROP TRIGGER IF EXISTS trg_touch_parent_issue_on_issue_update ON issues;
DROP FUNCTION IF EXISTS touch_parent_issue_on_issue_update();
