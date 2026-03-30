-- Restore cascade delete: property → issues (was incorrectly SET NULL)
ALTER TABLE public.issues
  DROP CONSTRAINT issues_property_id_fkey,
  ADD CONSTRAINT issues_property_id_fkey
    FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;

-- Restore cascade delete: issue → notifications (was incorrectly SET NULL)
ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_issue_id_fkey,
  ADD CONSTRAINT notifications_issue_id_fkey
    FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE CASCADE;
