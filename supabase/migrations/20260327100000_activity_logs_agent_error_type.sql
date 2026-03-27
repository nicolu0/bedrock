-- Add 'agent-error' and 'appfolio_note' to the activity_logs type constraint
ALTER TABLE activity_logs DROP CONSTRAINT activity_logs_type_check;

ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_type_check
  CHECK (type = ANY (ARRAY[
    'comment',
    'status_change',
    'assignee_change',
    'email_outbound',
    'email_inbound',
    'issue_created',
    'appfolio_approved',
    'appfolio_note',
    'agent-error'
  ]));
