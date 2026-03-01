-- Extend notifications table for typed, actionable notifications
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'info';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS meta JSONB;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS requires_action BOOLEAN NOT NULL DEFAULT false;

-- Track issue assignee
ALTER TABLE issues ADD COLUMN IF NOT EXISTS assignee_id UUID REFERENCES users(id);
