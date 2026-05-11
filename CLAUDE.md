# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

- **`agent/` is the active product.** This is where new work happens.
- **`src/` and `supabase/` are the legacy webapp — frozen.** Don't edit without discussing first. Reading is fine; debugging is fine.
- **Two customers, two PMSes already.** Vanessa (paying, Appfolio — day-to-day user is her PM Jose, not Vanessa) and Steve (free trial, Propertyware). Design the agent's PMS access as a pluggable surface. The "user" the agent talks to is the PM doing the work, not necessarily the buyer who signed.

## Product (the agent)

Lives in the property manager's iMessage. When a new work order comes in from the PMS, the agent texts the PM a summary and a suggested next action (vendor to dispatch, contact owner, etc.). It triages the tenant directly — via the PMS, SMS, or email depending on the PM's preferences — and keeps tabs on open work orders, following up in a few days when needed.

## Commands

```
npm run dev      # vite dev server (webapp)
npm run build    # vite build (Vercel adapter)
npm run check    # svelte-kit sync + svelte-check
npm run lint     # prettier --check + eslint
npm run format   # prettier --write
```

Agent (separate from the web app):

```
agent/imessage/run-messages.sh   # terminal 1: launch Messages.app with injected helper dylib
node agent/server.mjs            # terminal 2: poll loop + IPC listener on 127.0.0.1:9772
node agent/cli.mjs               # REPL testbed for the orchestrator, no iMessage
```

No test runner is configured. Formatting: tabs, single quotes, no trailing commas, printWidth 100 (see `.prettierrc`).

## Agent architecture (`agent/`)

Standalone Node app. Not bundled with the SvelteKit build. `agent/README.html` is the long-form reference.

Clean transport / core split:

- `agent/server.mjs` — transport. Polls `~/Library/Messages/chat.db` for new messages from unknown numbers, calls `runTurn`, maps orchestrator events to real iMessage signals (`read` → markRead, `typing` → setTyping, `message` → send via dylib).
- `agent/core/` — pure model logic, transport-agnostic.
  - `orchestrator.mjs` — streams one OpenAI turn with tool calls, emits events to the transport.
  - `tools.mjs` — `send_text`, profile read/write, observation logging.
  - `memory.mjs` — per-handle persistence at `agent/data/<handle>/{profile.json, observations.jsonl}`.
  - `prompts.mjs` — system prompt assembly.
- `agent/cli.mjs` — same orchestrator, terminal REPL, no iMessage. Use this for prompt/tool iteration.
- `agent/imessage/` — bridge to Messages.app. An arm64e dylib (`MessagesHelper/`) is DYLD-injected into Messages.app to call private `IMCore` methods (typing dots, read receipts) that AppleScript cannot reach. The Node side runs a TCP server on `127.0.0.1:9772`; the helper dials out because the Messages sandbox blocks `bind`/`listen` but allows `connect`. Wire format is JSON-lines. Host setup (disable Library Validation, disable SIP, `-arm64e_preview_abi` boot-arg) is documented in `agent/imessage/README.md` — this is a dedicated Mac mini, do not replicate on a daily-driver machine.

PMS integration is currently shaped around Appfolio (see legacy webapp's `appfolio-*` routes / edge functions). When wiring the agent to Appfolio, treat PMS access as a pluggable surface — second customer may not be on Appfolio.

## Webapp architecture (`src/`, `supabase/`) — frozen

Here so debugging is possible. Don't edit without asking.

SvelteKit 2 + Svelte 5 + Tailwind 4, deployed to Vercel. Auth and data via Supabase.

- `src/hooks.server.js` — per-request `@supabase/ssr` client, attaches `event.locals.supabase` / `event.locals.user`.
- `src/lib/supabaseClient.js` / `src/lib/supabaseAdmin.js` — browser anon vs. service-role. Only import `supabaseAdmin` from server code.
- `src/lib/server/` — server-only data layer: `loaders.js`, `workspaces.js`, `issueDashboard.js`, `notifications.js`, `tonePolicies.js`, `gmailPush.js`.
- `src/routes/(app)/[workspace]/` — authenticated workspace shell. Layout server loads enforce membership. Children: `inbox`, `issue`, `my-issues`, `people`, `policies`, `properties`, `settings`.
- `src/routes/api/` — JSON endpoints. Notable: `pubsub-hook` (Gmail push), `agent` / `agent-events` / `issue-agent` / `policy-agent` (LLM workflows), `appfolio-actions` / `appfolio-drafts`.
- `supabase/migrations/` — authoritative schema. Core entities: `workspaces`, `members`, `properties`, `people`, `issues`, `threads`/`messages`, `email_drafts`, `notifications`, `activity_logs`, `workspace_policies`.
- `supabase/functions/` — Deno edge functions (`agent`, `appfolio-email-trigger`, `appfolio-sync`, `chat`, `gmail-watch-renew`, `intake-agent`, `vendor-agent`). Run on Supabase, not Vercel.

Gmail uses Google Cloud Pub/Sub push → `/api/pubsub-hook` → `gmailPush.js`. `gmail-watch-renew` edge function keeps watches alive.

## Environment

`.env` required (gitignored). Keys: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_API_KEY`, `GMAIL_PUBSUB_TOPIC`, `AGENT_WEBHOOK_SECRET`, `MAILGUN_*`, `JOSE_CHAT_GUID`, `TARGET_PHONE_NUMBER`.

## MCP

`.mcp.json` configures the remote Supabase MCP (`https://mcp.supabase.com/mcp`) for inspecting the live project.
