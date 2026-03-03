-- Add workspace_id to messages (denormalized, populated via trigger from issues)
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION set_message_workspace_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT workspace_id INTO NEW.workspace_id FROM issues WHERE id = NEW.issue_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_message_workspace_id ON messages;
CREATE TRIGGER trg_message_workspace_id
BEFORE INSERT ON messages
FOR EACH ROW WHEN (NEW.workspace_id IS NULL AND NEW.issue_id IS NOT NULL)
EXECUTE FUNCTION set_message_workspace_id();

-- Backfill
UPDATE messages m SET workspace_id = i.workspace_id
FROM issues i WHERE i.id = m.issue_id AND m.workspace_id IS NULL;

-- Add workspace_id to email_drafts (denormalized, populated via trigger from issues)
ALTER TABLE public.email_drafts ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION set_email_draft_workspace_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT workspace_id INTO NEW.workspace_id FROM issues WHERE id = NEW.issue_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_email_draft_workspace_id ON email_drafts;
CREATE TRIGGER trg_email_draft_workspace_id
BEFORE INSERT ON email_drafts
FOR EACH ROW WHEN (NEW.workspace_id IS NULL AND NEW.issue_id IS NOT NULL)
EXECUTE FUNCTION set_email_draft_workspace_id();

-- Backfill
UPDATE email_drafts ed SET workspace_id = i.workspace_id
FROM issues i WHERE i.id = ed.issue_id AND ed.workspace_id IS NULL;
