-- Root-level vendor assignment for issues
--
-- Bedrock stores the selected vendor (from the draft vendor selector) on the *root* issue.
-- Subissues should display the same vendor by reading from the root.

ALTER TABLE public.issues
  ADD COLUMN IF NOT EXISTS vendor_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'issues_vendor_id_fkey'
      AND conrelid = 'public.issues'::regclass
  ) THEN
    ALTER TABLE public.issues
      ADD CONSTRAINT issues_vendor_id_fkey
      FOREIGN KEY (vendor_id)
      REFERENCES public.vendors(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS issues_vendor_id_idx ON public.issues (vendor_id);
