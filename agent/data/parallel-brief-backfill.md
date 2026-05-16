# Brief: chat.db → sessions → observations backfill

You're picking up a parallel track on the Bedrock memory-graph branch. The other track is closing out PR #1 of the memory graph (wiring the new tools into the chat skill + eval scenarios). Your job is independent of that.

## Repo context

Bedrock is a startup building an iMessage agent for property managers. Paying customer is **Vanessa / LAPM** (AppFolio); day-to-day user of the agent is her PM **Jose**. The agent lives in iMessage on a dedicated **Mac mini** (the only host with chat.db and the dylib that talks to Messages.app). All the live data — chat history with Jose — sits on that machine in `~/Library/Messages/chat.db`. The codebase you're working in is a worktree:

- **Path**: `/Users/andrewchang/work/bedrock/.claude/worktrees/memory-graph`
- **Branch**: `worktree-memory-graph` (worktree off `agentv1`)
- **CLAUDE.md** at the repo root has architecture; `agent/CLAUDE.md` has the agent specifics. Read both.

The design doc for the memory graph itself is at `~/.gstack/projects/bedrock/andrewchang-memory-graph-design-20260515-132022.md` — read the "Schema", "Tools added to the agent", and "Belief-former algorithm" sections; the rest is context.

## What's already built (do not rebuild)

- **Schema** (live in Supabase project `gfchomyeorzhbybfsqxf`):
  - `public.observations` — episodic, immutable. Columns: `id, workspace_id, ts, source_message_id, summary, raw_text, entities jsonb, salience real, tags text[], embedding vector(1536)`.
  - `public.beliefs` — semantic, mutable. `claim, scope, confidence, explicitness, created_by, tags, embedding`.
  - `public.belief_evidence` — join table, signed `weight` (positive supports, negative contradicts).
  - RPCs `match_observations` and `match_beliefs` exposed via PostgREST for vector search.
  - Migration file: `supabase/migrations/20260515133200_memory_graph.sql` (already applied).
- **Memory module**: `agent/core/memory.mjs` — Supabase REST wrapper. Exports `embed`, `addObservation`, `listObservations`, `recallObservations`, `createBelief`, `updateBelief`, `deleteBelief`, `listBeliefs`, `recallBeliefs`, `attachEvidence`, `evidenceFor`, `listEdges`.
- **Belief-former**: `agent/core/belief-former.mjs`. Runs on every `addObservation` call (fire-and-forget). Vector-fetches similar observations + beliefs, calls `gpt-5.4-2026-03-05` to classify into `attach | create | noop` ops, applies deterministic confidence math (decay=0.95, gain=0.15, penalty=0.2). Serialized per workspace via an in-process Promise chain.
- **Seed beliefs** (already in prod): 5 user-created beliefs from a Jose interview, all with embeddings populated. See `agent/data/seed-beliefs.json` and `agent/scripts/seed-beliefs.mjs`.
- **Memory tab UI**: `agent/work-orders/ui/page.html` + endpoints in `agent/work-orders/ui/index.mjs`. D3 force-directed graph. Run `node agent/ui-only.mjs` (port 7879) to view.

## What you're building

A one-off backfill script: `agent/scripts/backfill-from-chat.mjs`.

```
chat.db  →  filter to Jose groupchat  →  session-split  →  per-session LLM extract  →  observations  →  belief-former (auto)
```

### Scope (confirmed)

- **Source**: `~/Library/Messages/chat.db`. The script will run on the Mac mini.
- **Filter**: only the Jose groupchat. Its GUID is in the `JOSE_CHAT_GUID` env var. The mapping `JOSE_CHAT_GUID → workspace_id` is in `agent/work-orders/workspaces.mjs` (LAPM workspace, uuid `2e4373a0-40b8-42c2-a873-b08c99dbf76a`).
- **Output**: observations only. Each observation is written via `memory.addObservation()` which fires the belief-former automatically. You do NOT call belief-former directly.
- **Idempotency**: persist a per-chat watermark = highest `message.ROWID` processed. Re-runs only consume new messages. Suggest `agent/data/backfill-cursor.json` keyed by chat_guid.

### Concrete starting points

Read these before coding:

- `agent/server.mjs` lines 145–237 — the existing `chat.db` query. Specifically:
  - `getDb()` opens `~/Library/Messages/chat.db` via better-sqlite3
  - `extractText(row)` handles macOS Ventura+'s `attributedBody` NSAttributedString blob (you'll need this — `m.text` is often null on newer macOS)
  - The query joins `message × chat_message_join × chat × handle` and filters `m.service = 'iMessage'` and `c.style = 45` (group chat) or matches a specific `c.guid`
- `agent/work-orders/workspaces.mjs` — has the `chatEnv → workspace_id` mapping. Resolve `JOSE_CHAT_GUID` from env, then look up workspace_id.
- `agent/core/memory.mjs` — the `addObservation(workspace_id, { summary, raw_text, entities, salience, tags, source_message_id })` signature.
- `agent/scripts/seed-beliefs.mjs` — example of a standalone Node script that loads .env, talks to the memory module. Mirror this structure.

### Algorithm

1. **Read watermark**: load `agent/data/backfill-cursor.json`. Default `{ [chat_guid]: 0 }`.
2. **Query chat.db**: select all messages from Jose's chat_guid with `ROWID > watermark`, ordered ASC. Use the existing `extractText` helper.
3. **Session-split**: walk messages in order. New session whenever `(message.date - prev.date) > 4 hours`. Apple date is nanoseconds since 2001-01-01 — convert to JS Date.
4. **For each session** (skip sessions with <2 messages or empty text):
   - Build a transcript: `[timestamp, handle, text]` lines.
   - Call LLM (`gpt-5.4-2026-03-05`) with a prompt asking: "Extract belief-worthy observations from this session. Each observation is one PM signal: a stated preference, a correction, an observed dispatch pattern, a per-property quirk. Skip routine work-order chatter that doesn't generalize." Use **structured JSON output** (response_format json_schema, strict) so you get back a list of `{summary, salience, entities, tags, raw_text, source_message_id}`.
   - For each extracted observation, call `memory.addObservation(workspace_id, observation)`. This fires the belief-former.
   - The serializer in belief-former.mjs already queues them per-workspace; you can call addObservation in a tight loop without worrying about races.
5. **Advance watermark**: set the cursor to the highest ROWID in this batch.
6. **Print summary**: `N sessions processed, M observations extracted, watermark advanced to ROWID X`.

### Acceptance criteria

- `node agent/scripts/backfill-from-chat.mjs --dry-run` lists sessions + would-be observations without writing.
- `node agent/scripts/backfill-from-chat.mjs --workspace=prod --limit=5` processes 5 sessions, writes observations, leaves the rest for a next run.
- `node agent/scripts/backfill-from-chat.mjs --workspace=prod` (no limit) processes everything new since the last watermark.
- Re-running immediately is a near-no-op (watermark catches up).
- Memory tab graph (`http://127.0.0.1:7879/`, **Memory**, **Prod**) shows new observation nodes connected to the 5 existing beliefs. New beliefs may also appear if the LLM classified the observation as `create`.
- No `LAPM` prod issues_v2 / vendor / property data is touched. **Only** `observations`, `beliefs`, `belief_evidence` get writes.

### Eval discipline (READ THIS — required)

The agent codebase has a hard rule from `agent/CLAUDE.md`:

> Before shipping any change that touches a skill prompt, a tool description, a tool's `run` function, or the orchestrator loop, run the suite and confirm no regressions.

You are NOT touching any of those. You're adding a backfill script that calls existing memory primitives. Evals are not required for the backfill itself. **However**: if you find yourself modifying `agent/core/memory.mjs`, `agent/core/belief-former.mjs`, or any `agent/tools/*.mjs`, you must run `node agent/evals/run.mjs` before committing.

If you want to add an eval-style smoke test for the backfill — e.g. "given this fixture transcript, produce these observations" — put it in `agent/scripts/backfill-smoke.mjs`, not in the main eval suite. The main suite is for orchestrator-skill behavior.

### Gotchas

- **`attributedBody` parsing**: `m.text` is often null in macOS Ventura+. Use the existing `extractText` helper, don't reinvent.
- **Apple timestamps**: `message.date` is nanoseconds since 2001-01-01 UTC. `new Date(978307200000 + date/1e6)` (note the 1e6 not 1e9 — the existing code uses milliseconds since 2001 actually; check the helper).
- **Chat schema variations**: macOS has changed the schema across versions (`style` 43 vs 45, `room_name` semantics). The existing query handles this; copy its WHERE clause verbatim.
- **Long sessions**: a single long session might exceed the model's context. Set a max-tokens guard: if a session exceeds ~8K tokens of transcript, chunk it. For PR #1 a hard cutoff at 200 messages per session is fine.
- **Cost**: at ~$0.05–0.20 per session with gpt-5.4-2026-03-05, 50 sessions = $2–10. Print a cost estimate before processing in non-dry-run mode. Require `--confirm-cost` to actually write.
- **Don't touch the live chat poller's state.** `agent/data/state.json` (the `lastSeenRowId`) is owned by `server.mjs`. Your backfill cursor is separate.

### Verifying it worked

After a real run against prod:

1. Open `http://127.0.0.1:7879/`, click **Memory**, switch to **Prod**. Expect new observation nodes (small grey circles) and edges to existing beliefs.
2. Click a belief — its evidence list should now have real observations attached, with snippets of the Jose transcript.
3. Confidence on existing beliefs should have shifted (mostly upward — Jose's actual usage validates the seed beliefs).
4. Some new `agent`-created beliefs may exist (no amber stroke — neutral grey ring). Sanity-check one — does the claim make sense?

### Suggested commit message

> `feat: chat.db → observations backfill for memory graph`

Don't push; the parent maintainer will batch with PR #1 changes.

### Out of scope (do not do these)

- Don't wire the chat skill (the parallel PR #1 track is doing this).
- Don't add eval scenarios to the main suite.
- Don't touch `agent/core/belief-former.mjs` or `agent/core/memory.mjs` unless you find a bug — if you do, run evals.
- Don't backfill any workspace other than the Jose one.
- Don't modify `agent/data/state.json`.
- Don't create vault notes — those are for product decisions; this is implementation.

### Questions you might have

- **"Should the backfill script also be the live ingestion path?"** No. The live path is `server.mjs` → chat skill → tools. The backfill is a one-shot batch over history. They overlap only in that both eventually write observations.
- **"What if a session is unrelated chit-chat?"** The LLM extract prompt should be conservative — emit zero observations rather than noise. Tell it: "If nothing in this session would change how the agent handles future work orders, emit no observations."
- **"How do I test without writing to prod?"** Add `--workspace=test` support. The test workspace is `40d675ba-4dec-47dd-9222-79c0345c493f`. Or use `--dry-run` to print intended writes without committing.

Good luck. Ping the parent session when you're done so it can merge.
