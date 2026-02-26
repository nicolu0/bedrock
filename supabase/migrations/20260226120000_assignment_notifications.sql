-- Extend notifications table for typed, actionable notifications
ALTER TABLE notifications ADD COLUMN type TEXT NOT NULL DEFAULT 'info';
ALTER TABLE notifications ADD COLUMN meta JSONB;
ALTER TABLE notifications ADD COLUMN requires_action BOOLEAN NOT NULL DEFAULT false;

-- Track issue assignee
ALTER TABLE issues ADD COLUMN assignee_id UUID REFERENCES users(id);
