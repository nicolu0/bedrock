-- Migrate existing people with role='owner' into the new owners table,
-- move properties.owner_id relationships into owner_properties,
-- update affected RLS policies, and drop properties.owner_id.

BEGIN;

-- 1. Seed owners from existing people records with role='owner'
INSERT INTO public.owners (workspace_id, people_id, name, email, phone, created_at, updated_at)
SELECT
  p.workspace_id,
  p.id,
  COALESCE(p.name, 'Unknown'),
  p.email,
  p.phone,
  p.created_at,
  p.updated_at
FROM public.people p
WHERE p.role = 'owner'
ON CONFLICT DO NOTHING;

-- 2. Migrate properties.owner_id -> owner_properties join table
INSERT INTO public.owner_properties (owner_id, property_id, workspace_id)
SELECT
  o.id,
  pr.id,
  pr.workspace_id
FROM public.properties pr
JOIN public.owners o ON o.people_id = pr.owner_id
WHERE pr.owner_id IS NOT NULL
ON CONFLICT (owner_id, property_id) DO NOTHING;

-- 3. Update RLS policies that reference properties.owner_id

-- properties: "Properties can be read by role"
DROP POLICY IF EXISTS "Properties can be read by role" ON public.properties;
CREATE POLICY "Properties can be read by role" ON public.properties
  FOR SELECT USING (
    (EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = properties.workspace_id AND w.admin_user_id = auth.uid()
    ))
    OR lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
    OR EXISTS (
      SELECT 1
      FROM public.owner_properties op
      JOIN public.owners o ON o.id = op.owner_id
      JOIN public.people p ON p.id = o.people_id
      WHERE op.property_id = properties.id
        AND p.user_id = auth.uid()
    )
  );

-- units: "Workspace members can view units"
DROP POLICY IF EXISTS "Workspace members can view units" ON public.units;
CREATE POLICY "Workspace members can view units" ON public.units
  FOR SELECT USING (
    (EXISTS (
      SELECT 1
      FROM public.properties pr
      JOIN public.people p ON p.workspace_id = pr.workspace_id
      WHERE pr.id = units.property_id
        AND p.user_id = auth.uid()
        AND p.role = ANY (ARRAY['admin'::people_role, 'member'::people_role])
    ))
    OR EXISTS (
      SELECT 1
      FROM public.owner_properties op
      JOIN public.owners o ON o.id = op.owner_id
      JOIN public.people p ON p.id = o.people_id
      WHERE op.property_id = units.property_id
        AND p.user_id = auth.uid()
    )
  );

-- issues: "Issues can be read by role"
DROP POLICY IF EXISTS "Issues can be read by role" ON public.issues;
CREATE POLICY "Issues can be read by role" ON public.issues
  FOR SELECT USING (
    (EXISTS (
      SELECT 1 FROM public.people p
      WHERE p.workspace_id = issues.workspace_id
        AND p.user_id = auth.uid()
        AND p.role = ANY (ARRAY['admin'::people_role, 'bedrock'::people_role])
    ))
    OR (EXISTS (
      SELECT 1 FROM public.people p
      WHERE p.workspace_id = issues.workspace_id
        AND p.user_id = auth.uid()
        AND p.role = ANY (ARRAY['member'::people_role, 'vendor'::people_role])
        AND issues.assignee_id = auth.uid()
    ))
    OR EXISTS (
      SELECT 1
      FROM public.units u
      JOIN public.owner_properties op ON op.property_id = u.property_id
      JOIN public.owners o ON o.id = op.owner_id
      JOIN public.people p ON p.id = o.people_id
      WHERE u.id = issues.unit_id
        AND p.user_id = auth.uid()
        AND p.workspace_id = issues.workspace_id
    )
  );

-- tenants: "Workspace members can view tenants"
-- The old second OR (p.owner_id = auth.uid()) was a bug comparing people.id to auth.uid()
DROP POLICY IF EXISTS "Workspace members can view tenants" ON public.tenants;
CREATE POLICY "Workspace members can view tenants" ON public.tenants
  FOR SELECT USING (
    (EXISTS (
      SELECT 1
      FROM public.units u
      JOIN public.properties p ON p.id = u.property_id
      JOIN public.people pe ON pe.workspace_id = p.workspace_id
      WHERE u.id = tenants.unit_id
        AND pe.user_id = auth.uid()
        AND pe.role = ANY (ARRAY['admin'::people_role, 'member'::people_role, 'owner'::people_role])
    ))
    OR EXISTS (
      SELECT 1
      FROM public.units u
      JOIN public.owner_properties op ON op.property_id = u.property_id
      JOIN public.owners o ON o.id = op.owner_id
      JOIN public.people p ON p.id = o.people_id
      WHERE u.id = tenants.unit_id
        AND p.user_id = auth.uid()
    )
  );

-- 4. Drop the trigger and function that validated properties.owner_id,
--    then drop the column itself
DROP TRIGGER IF EXISTS properties_owner_role_check ON public.properties;
DROP FUNCTION IF EXISTS validate_property_owner_role();
ALTER TABLE public.properties DROP COLUMN IF EXISTS owner_id;

COMMIT;
