-- Expand the activity_logs type check constraint to include
-- 'issue_created' (AppFolio work order creation log) and
-- 'appfolio_approved' (PM approval of an AppFolio draft).
ALTER TABLE activity_logs DROP CONSTRAINT activity_logs_type_check;

ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_type_check
  CHECK (type = ANY (ARRAY[
    'comment',
    'status_change',
    'assignee_change',
    'email_outbound',
    'email_inbound',
    'issue_created',
    'appfolio_approved'
  ]));
