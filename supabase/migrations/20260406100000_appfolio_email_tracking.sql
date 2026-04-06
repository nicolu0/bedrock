ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS appfolio_email_tracking boolean NOT NULL DEFAULT false;
