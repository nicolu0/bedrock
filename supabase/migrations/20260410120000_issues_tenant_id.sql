ALTER TABLE public.issues
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS issues_tenant_id_idx ON public.issues (tenant_id) WHERE tenant_id IS NOT NULL;
