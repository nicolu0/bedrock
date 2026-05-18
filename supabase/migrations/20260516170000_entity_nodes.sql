-- Entity nodes for the memory graph: promote vendors, properties, and owners
-- to first-class entity rows that beliefs and (later) observations can edge to.
--
-- Entities are created on-demand when the LLM names something — not pre-loaded
-- from the legacy vendors/properties/owners tables. When a name matches a row
-- in one of those tables, the entity row optionally points to it via
-- ref_table/ref_id so we don't lose the structured Appfolio data.
--
-- Belief consolidation relies on entity-FK candidate retrieval: when a new
-- observation about Kori comes in, the belief-former pulls every belief that
-- already shares an entity with this observation, which finds the existing
-- "Kori is handyman for Harrison Properties" belief and lets the LLM attach
-- instead of creating a duplicate.

CREATE TABLE public.entities (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind            text        NOT NULL,                  -- vendor | property | owner (v1)
  name            text        NOT NULL,
  name_embedding  vector(1536),                          -- for fuzzy resolution
  ref_table       text,                                  -- 'vendors' | 'properties' | 'owners' | null
  ref_id          uuid,                                  -- foreign key into the legacy table
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One entity per legacy row max. Two LLM mentions of "Mario" both resolve to
-- the same entity row regardless of small name variants. The NULLS NOT
-- DISTINCT clause keeps informal entities (ref_table=null) from colliding —
-- two unmatched names can coexist.
CREATE UNIQUE INDEX entities_ref_unique_idx
  ON public.entities (workspace_id, ref_table, ref_id)
  WHERE ref_table IS NOT NULL;

CREATE INDEX entities_workspace_kind_idx
  ON public.entities (workspace_id, kind);

-- HNSW for the name-similarity fallback when no legacy row matches.
CREATE INDEX entities_name_embedding_idx
  ON public.entities USING hnsw (name_embedding vector_cosine_ops);

-- Keep updated_at honest.
CREATE OR REPLACE FUNCTION public.entities_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER entities_updated_at_trigger
  BEFORE UPDATE ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.entities_set_updated_at();

-- ── belief_entities ──────────────────────────────────────────────────────────
-- M:M between beliefs and entities. A belief like "Kori is handyman for
-- Harrison Properties" has two edges — to vendor:Kori and to owner:Harrison
-- Properties. A workspace-policy belief like "owner approval required" has
-- one edge to its owner. A trade-only belief like "Yonic is primary plumber"
-- has one edge to vendor:Yonic.
CREATE TABLE public.belief_entities (
  belief_id    uuid        NOT NULL REFERENCES public.beliefs(id)   ON DELETE CASCADE,
  entity_id    uuid        NOT NULL REFERENCES public.entities(id)  ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (belief_id, entity_id)
);

CREATE INDEX belief_entities_entity_idx
  ON public.belief_entities (entity_id);
