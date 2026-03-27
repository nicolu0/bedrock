-- Rename table (indexes and FK constraints auto-rename; trigger stays bound by OID)
ALTER TABLE public.email_drafts RENAME TO drafts;

-- Add channel field (existing rows default to 'email' — correct)
ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email'
    CHECK (channel IN ('email', 'appfolio'));

-- Ensure realtime publication covers the renamed table
-- (Supabase may track by name in its metadata layer; ADD TABLE is idempotent)
ALTER PUBLICATION supabase_realtime ADD TABLE public.drafts;
