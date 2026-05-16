-- Memory graph: episodic observations + semantic beliefs joined by belief_evidence.
-- Replaces the file-based agent/memory.mjs store for the iMessage agent and
-- becomes the read surface for the upstream vendor edge function (PR #2).

CREATE EXTENSION IF NOT EXISTS vector;

-- ── enums ────────────────────────────────────────────────────────────────────
CREATE TYPE belief_explicitness AS ENUM ('stated', 'inferred');
CREATE TYPE belief_creator      AS ENUM ('agent', 'user');

-- ── observations ─────────────────────────────────────────────────────────────
-- Episodic, immutable. One row per PM signal worth remembering. The
-- belief-former reads these (vector-similar + scoped) when consolidating.
CREATE TABLE public.observations (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ts                timestamptz NOT NULL DEFAULT now(),
  source_message_id text,
  summary           text        NOT NULL,
  raw_text          text,
  entities          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  salience          real        NOT NULL,
  tags              text[]      NOT NULL DEFAULT '{}',
  embedding         vector(1536)
);

CREATE INDEX observations_workspace_ts_idx
  ON public.observations (workspace_id, ts DESC);

CREATE INDEX observations_entities_idx
  ON public.observations USING gin (entities);

-- HNSW chosen over ivfflat: no tuning needed, better recall at our scale.
CREATE INDEX observations_embedding_idx
  ON public.observations USING hnsw (embedding vector_cosine_ops);

-- RLS intentionally off for PR #1. Service-role key is the only writer; the
-- dashboard reads via the same key from the Mac mini. Revisit when a browser
-- client talks to these tables directly.

-- ── beliefs ──────────────────────────────────────────────────────────────────
-- Semantic, mutable. Derived from observations (created_by='agent') or seeded
-- manually (created_by='user'). The vendor edge function reads beliefs by
-- (workspace_id, scope, claim) to inform recommendations.
CREATE TABLE public.beliefs (
  id            uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid                 NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  claim         text                 NOT NULL,
  scope         jsonb                NOT NULL DEFAULT '{}'::jsonb,
  confidence    real                 NOT NULL,
  explicitness  belief_explicitness  NOT NULL,
  created_by    belief_creator       NOT NULL,
  created_at    timestamptz          NOT NULL DEFAULT now(),
  updated_at    timestamptz          NOT NULL DEFAULT now(),
  tags          text[]               NOT NULL DEFAULT '{}',
  embedding     vector(1536)
);

CREATE INDEX beliefs_workspace_idx
  ON public.beliefs (workspace_id);

CREATE INDEX beliefs_scope_idx
  ON public.beliefs USING gin (scope);

CREATE INDEX beliefs_embedding_idx
  ON public.beliefs USING hnsw (embedding vector_cosine_ops);

-- ── belief_evidence ──────────────────────────────────────────────────────────
-- Many-to-many edge between observations and beliefs. weight contributes to
-- the deterministic confidence formula (positive = supports, negative =
-- contradicts).
CREATE TABLE public.belief_evidence (
  belief_id      uuid        NOT NULL REFERENCES public.beliefs(id)      ON DELETE CASCADE,
  observation_id uuid        NOT NULL REFERENCES public.observations(id) ON DELETE CASCADE,
  weight         real        NOT NULL DEFAULT 1.0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (belief_id, observation_id)
);

CREATE INDEX belief_evidence_observation_idx
  ON public.belief_evidence (observation_id);

-- Keep beliefs.updated_at honest. Hand-rolled trigger to avoid pulling in
-- moddatetime extension just for this.
CREATE OR REPLACE FUNCTION public.beliefs_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER beliefs_updated_at_trigger
  BEFORE UPDATE ON public.beliefs
  FOR EACH ROW EXECUTE FUNCTION public.beliefs_set_updated_at();

-- ── RPC: vector-search observations within a workspace ───────────────────────
-- The Node side embeds the query string with text-embedding-3-small and passes
-- the vector here. PostgREST exposes this as POST /rest/v1/rpc/match_observations.
CREATE OR REPLACE FUNCTION public.match_observations(
  query_embedding   vector(1536),
  workspace_id_in   uuid,
  match_count       int    DEFAULT 5,
  similarity_floor  real   DEFAULT 0.0
)
RETURNS TABLE (
  id                uuid,
  workspace_id      uuid,
  ts                timestamptz,
  source_message_id text,
  summary           text,
  raw_text          text,
  entities          jsonb,
  salience          real,
  tags              text[],
  similarity        real
)
LANGUAGE sql STABLE AS $$
  SELECT
    o.id,
    o.workspace_id,
    o.ts,
    o.source_message_id,
    o.summary,
    o.raw_text,
    o.entities,
    o.salience,
    o.tags,
    (1 - (o.embedding <=> query_embedding))::real AS similarity
  FROM public.observations o
  WHERE o.workspace_id = workspace_id_in
    AND o.embedding IS NOT NULL
    AND (1 - (o.embedding <=> query_embedding)) >= similarity_floor
  ORDER BY o.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── RPC: vector-search beliefs within a workspace ────────────────────────────
CREATE OR REPLACE FUNCTION public.match_beliefs(
  query_embedding   vector(1536),
  workspace_id_in   uuid,
  match_count       int    DEFAULT 5,
  similarity_floor  real   DEFAULT 0.0
)
RETURNS TABLE (
  id            uuid,
  workspace_id  uuid,
  claim         text,
  scope         jsonb,
  confidence    real,
  explicitness  belief_explicitness,
  created_by    belief_creator,
  created_at    timestamptz,
  updated_at    timestamptz,
  tags          text[],
  similarity    real
)
LANGUAGE sql STABLE AS $$
  SELECT
    b.id,
    b.workspace_id,
    b.claim,
    b.scope,
    b.confidence,
    b.explicitness,
    b.created_by,
    b.created_at,
    b.updated_at,
    b.tags,
    (1 - (b.embedding <=> query_embedding))::real AS similarity
  FROM public.beliefs b
  WHERE b.workspace_id = workspace_id_in
    AND b.embedding IS NOT NULL
    AND (1 - (b.embedding <=> query_embedding)) >= similarity_floor
  ORDER BY b.embedding <=> query_embedding
  LIMIT match_count;
$$;
