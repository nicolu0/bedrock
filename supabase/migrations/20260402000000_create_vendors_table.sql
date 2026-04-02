-- Create dedicated vendors table
CREATE TABLE IF NOT EXISTS public.vendors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  email         text,
  phone         text,
  trade         text,
  note          text,
  appfolio_vendor_id text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendors_workspace_id_idx
  ON public.vendors(workspace_id);

ALTER TABLE public.vendors
  ADD CONSTRAINT vendors_workspace_appfolio_vendor_id_unique
  UNIQUE (workspace_id, appfolio_vendor_id);

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view vendors"
  ON public.vendors FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can insert vendors"
  ON public.vendors FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can update vendors"
  ON public.vendors FOR UPDATE
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can delete vendors"
  ON public.vendors FOR DELETE
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Migrate existing vendor data from people table
INSERT INTO public.vendors (workspace_id, name, email, trade, note, appfolio_vendor_id, created_at)
SELECT workspace_id, name, email, trade, notes, appfolio_vendor_id, created_at
FROM public.people
WHERE role = 'vendor'
ON CONFLICT DO NOTHING;

-- Remap recommended_vendors JSONB IDs on issues to point to new vendors table
UPDATE public.issues
SET recommended_vendors = (
  SELECT jsonb_agg(
    CASE
      WHEN v.id IS NOT NULL THEN jsonb_set(elem, '{id}', to_jsonb(v.id::text))
      ELSE elem
    END
  )
  FROM jsonb_array_elements(recommended_vendors) AS elem
  LEFT JOIN public.people p ON p.id = (elem->>'id')::uuid AND p.role = 'vendor'
  LEFT JOIN public.vendors v ON v.workspace_id = p.workspace_id
    AND v.email = p.email AND v.name = p.name
)
WHERE recommended_vendors IS NOT NULL
  AND jsonb_typeof(recommended_vendors) = 'array';
