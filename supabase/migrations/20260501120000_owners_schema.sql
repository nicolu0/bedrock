-- owners: dedicated table for property owners synced from Appfolio
CREATE TABLE public.owners (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  people_id           uuid        REFERENCES public.people(id) ON DELETE SET NULL,
  appfolio_owner_id   text,
  name                text        NOT NULL,
  email               text,
  phone               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX owners_appfolio_id_workspace_unique
  ON public.owners (workspace_id, appfolio_owner_id)
  WHERE appfolio_owner_id IS NOT NULL;

CREATE INDEX owners_workspace_id_idx ON public.owners (workspace_id);
CREATE INDEX owners_people_id_idx ON public.owners (people_id);

ALTER TABLE public.owners ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can be read by workspace members" ON public.owners
  FOR SELECT USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
    OR (
      people_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.people p
        WHERE p.id = owners.people_id AND p.user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Admins can insert owners" ON public.owners
  FOR INSERT WITH CHECK (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

CREATE POLICY "Admins can update owners" ON public.owners
  FOR UPDATE USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

CREATE POLICY "Admins can delete owners" ON public.owners
  FOR DELETE USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

-- owner_properties: many-to-many join between owners and properties
CREATE TABLE public.owner_properties (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid        NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  property_id uuid        NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  workspace_id uuid       NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, property_id)
);

CREATE INDEX owner_properties_owner_id_idx     ON public.owner_properties (owner_id);
CREATE INDEX owner_properties_property_id_idx  ON public.owner_properties (property_id);
CREATE INDEX owner_properties_workspace_id_idx ON public.owner_properties (workspace_id);

ALTER TABLE public.owner_properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner properties can be read by workspace members" ON public.owner_properties
  FOR SELECT USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
    OR EXISTS (
      SELECT 1
      FROM public.owners o
      JOIN public.people p ON p.id = o.people_id
      WHERE o.id = owner_properties.owner_id
        AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "Admins can insert owner properties" ON public.owner_properties
  FOR INSERT WITH CHECK (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

CREATE POLICY "Admins can update owner properties" ON public.owner_properties
  FOR UPDATE USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

CREATE POLICY "Admins can delete owner properties" ON public.owner_properties
  FOR DELETE USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

-- owner_notes: notes for an owner, optionally scoped to a specific property
CREATE TABLE public.owner_notes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid       NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_id    uuid        NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  property_id uuid        REFERENCES public.properties(id) ON DELETE SET NULL,
  content     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX owner_notes_owner_id_idx    ON public.owner_notes (owner_id);
CREATE INDEX owner_notes_property_id_idx ON public.owner_notes (property_id) WHERE property_id IS NOT NULL;
CREATE INDEX owner_notes_workspace_id_idx ON public.owner_notes (workspace_id);

ALTER TABLE public.owner_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner notes can be read by workspace members" ON public.owner_notes
  FOR SELECT USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
    OR EXISTS (
      SELECT 1
      FROM public.owners o
      JOIN public.people p ON p.id = o.people_id
      WHERE o.id = owner_notes.owner_id
        AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "Admins can insert owner notes" ON public.owner_notes
  FOR INSERT WITH CHECK (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

CREATE POLICY "Admins can update owner notes" ON public.owner_notes
  FOR UPDATE USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );

CREATE POLICY "Admins can delete owner notes" ON public.owner_notes
  FOR DELETE USING (
    lower(current_people_role(workspace_id)) = ANY (ARRAY['admin'::text, 'member'::text, 'bedrock'::text])
  );
