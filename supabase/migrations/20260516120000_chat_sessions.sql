-- Chat sessions + messages: persisted sessionization of the iMessage groupchat
-- with the PM. Sessions are conversationally-continuous runs of messages (can
-- carry multiple topics). chat_messages mirrors chat.db rows in scope so the
-- dashboard and edge functions can read transcripts without Mac mini access.

-- ── chat_sessions ────────────────────────────────────────────────────────────
-- One row per coherent back-and-forth in a chat. Boundaries are decided by
-- the sessionizer (hard time-gate + LLM continuity judge for the middle
-- ground). Summary/embedding populated when the session closes (or on
-- periodic refresh while open). issue_ids/entities/tags mirror the
-- observations/beliefs surfaces so cross-session connections flow through
-- the same query patterns.
CREATE TABLE public.chat_sessions (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  chat_guid                 text        NOT NULL,
  started_at                timestamptz NOT NULL,
  ended_at                  timestamptz,                            -- null = still open
  message_count             int         NOT NULL DEFAULT 0,
  participants              text[]      NOT NULL DEFAULT '{}',
  issue_ids                 uuid[]      NOT NULL DEFAULT '{}',
  entities                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  tags                      text[]      NOT NULL DEFAULT '{}',
  summary                   text,                                   -- null until first summarize
  embedding                 vector(1536),                           -- null until first embed
  observations_extracted_at timestamptz                             -- null = backfill phase 2 not run yet
);

-- Partial index for "what's the currently-open session for this chat" — the
-- single hottest read path in the sessionizer.
CREATE INDEX chat_sessions_chat_open_idx
  ON public.chat_sessions (chat_guid, started_at DESC)
  WHERE ended_at IS NULL;

CREATE INDEX chat_sessions_workspace_idx
  ON public.chat_sessions (workspace_id, started_at DESC);

-- Cross-session connections: issue_ids[], entities jsonb, tags text[] mirror
-- the surfaces on observations/beliefs so the same query patterns work.
CREATE INDEX chat_sessions_issue_ids_idx
  ON public.chat_sessions USING gin (issue_ids);

CREATE INDEX chat_sessions_entities_idx
  ON public.chat_sessions USING gin (entities);

CREATE INDEX chat_sessions_tags_idx
  ON public.chat_sessions USING gin (tags);

CREATE INDEX chat_sessions_embedding_idx
  ON public.chat_sessions USING hnsw (embedding vector_cosine_ops);

-- RLS off for the same reason as observations/beliefs: service-role key is
-- the only writer; dashboard reads via the same key from the Mac mini.

-- ── chat_messages ────────────────────────────────────────────────────────────
-- Mirror of chat.db rows for in-scope chats. session_id links each message
-- to its session; issue_id is set on agent-triggered outgoing messages (the
-- send path knows the issue at send time). UNIQUE(chat_guid, source_guid)
-- makes ingest idempotent — re-running the backfill is safe.
CREATE TABLE public.chat_messages (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  session_id    uuid        REFERENCES public.chat_sessions(id) ON DELETE SET NULL,
  chat_guid     text        NOT NULL,
  handle        text,                                    -- null when is_from_me
  is_from_me    boolean     NOT NULL,
  body          text        NOT NULL,
  ts            timestamptz NOT NULL,
  source_rowid  bigint      NOT NULL,                    -- chat.db ROWID
  source_guid   text        NOT NULL,                    -- chat.db message guid
  issue_id      uuid,                                    -- set on agent-triggered sends
  UNIQUE (chat_guid, source_guid)
);

CREATE INDEX chat_messages_session_ts_idx
  ON public.chat_messages (session_id, ts);

CREATE INDEX chat_messages_chat_ts_idx
  ON public.chat_messages (chat_guid, ts);

-- ── RPC: vector-search sessions within a workspace ───────────────────────────
-- The Node side embeds the query string with text-embedding-3-small and
-- passes the vector here. PostgREST exposes this as POST
-- /rest/v1/rpc/match_chat_sessions. Mirror of match_observations /
-- match_beliefs.
CREATE OR REPLACE FUNCTION public.match_chat_sessions(
  query_embedding   vector(1536),
  workspace_id_in   uuid,
  match_count       int  DEFAULT 5,
  similarity_floor  real DEFAULT 0.0
)
RETURNS TABLE (
  id            uuid,
  chat_guid     text,
  started_at    timestamptz,
  ended_at      timestamptz,
  summary       text,
  issue_ids     uuid[],
  entities      jsonb,
  tags          text[],
  message_count int,
  similarity    real
)
LANGUAGE sql STABLE AS $$
  SELECT
    s.id,
    s.chat_guid,
    s.started_at,
    s.ended_at,
    s.summary,
    s.issue_ids,
    s.entities,
    s.tags,
    s.message_count,
    (1 - (s.embedding <=> query_embedding))::real AS similarity
  FROM public.chat_sessions s
  WHERE s.workspace_id = workspace_id_in
    AND s.embedding IS NOT NULL
    AND (1 - (s.embedding <=> query_embedding)) >= similarity_floor
  ORDER BY s.embedding <=> query_embedding
  LIMIT match_count;
$$;
