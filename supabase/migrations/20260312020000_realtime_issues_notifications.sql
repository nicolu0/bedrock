-- Enable realtime for issues
-- FULL identity needed so DELETE events include workspace_id for filtering
ALTER TABLE public.issues REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.issues;

-- Enable realtime for notifications (already has REPLICA IDENTITY FULL)
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- Enable realtime for email_drafts (layout subscribes to it but it's missing from publication)
ALTER TABLE public.email_drafts REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.email_drafts;
