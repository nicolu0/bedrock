// Sessionizer — groups iMessage rows into conversationally-continuous sessions
// and persists them to Supabase (chat_sessions + chat_messages). Sessions can
// carry multiple topics; the boundary is "is this a continuation of the live
// thread, or a fresh outreach after the prior one wound down?", not "is the
// topic the same?".
//
// Boundary algorithm:
//   - hard rules (no LLM call):
//       no open session              -> new session
//       gap >= HARD_NEW_MS  (14 d)   -> new session
//       gap <= HARD_CONTINUE_MS (5m) -> continue
//   - middle ground: LLM judge with running session summary + last few
//     messages, returns {continue: bool}. Leans toward continue=true.
//
// On close: one LLM call returns {summary, entities, tags}; we embed the
// summary and PATCH the chat_sessions row. issue_ids is computed from member
// chat_messages, not LLM-emitted.
//
// Concurrency: single Mac mini host, one process. In-process Map keyed by
// chat_guid holds open-session state. No locking needed.

import { embed } from './memory.mjs';
import { supabaseEnv } from '../supabase.mjs';
import { WORKSPACES } from '../work-orders/workspaces.mjs';

// True if this handle is one of the configured agent personas for the
// workspace (cofounders' phones). Pre-pivot the cofounders sent real human
// messages; post-pivot they are the agent. We collapse them to "agent" for
// LLM-facing transcripts so the model gets a coherent two-party view.
function isAgentHandle(workspace_id, handle) {
	if (!handle) return false;
	return (WORKSPACES[workspace_id]?.agent_handles ?? []).includes(handle);
}

function effectiveSender(workspace_id, is_from_me, handle) {
	if (is_from_me) return 'agent';
	if (isAgentHandle(workspace_id, handle)) return 'agent';
	return handle || 'unknown';
}

// ── constants ────────────────────────────────────────────────────────────────

const HARD_CONTINUE_MS = 5 * 60 * 1000;
// 7 days: only multi-day silences trigger a hard split. Sessions in this
// chat span full workdays and often spill into the next morning when Jose
// replies overnight to an open question. A shorter hard cut over-splits
// genuine follow-ups; we let the LLM judge handle everything sub-week.
const HARD_NEW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MSG_COUNT = 6;
// The boundary judge handles a nuanced continue/new call. Mini drifts hard
// toward whatever default the prompt leans on; the full model holds the
// criteria more reliably. Cost is still under $0.20 for the full backfill.
const BOUNDARY_MODEL = process.env.SESSIONIZER_JUDGE_MODEL || 'gpt-5.4-2026-03-05';
const SUMMARY_MODEL = process.env.SESSIONIZER_SUMMARY_MODEL || 'gpt-5.4-mini-2026-03-17';

// ── in-process cache ─────────────────────────────────────────────────────────
// chat_guid -> { session_id, workspace_id, started_at, last_ts, message_count,
//                recent: [{ts, sender, body}], issue_ids: Set, participants: Set }
const openSessions = new Map();

// ── public api ───────────────────────────────────────────────────────────────

/**
 * Ingest one chat.db row. Idempotent via chat_messages UNIQUE(chat_guid, source_guid).
 * Returns { session_id, opened_new, just_closed_id }.
 *
 * Pass `judgeOverride` to bypass the LLM judge for dry-runs/tests — receives
 * { gap_ms, open, msg } and returns 'continue' | 'new'.
 */
export async function ingestMessage(
	{
		workspace_id,
		chat_guid,
		handle,
		is_from_me,
		body,
		ts,
		source_rowid,
		source_guid,
		issue_id = null
	},
	{ judgeOverride = null } = {}
) {
	if (!workspace_id) throw new Error('ingestMessage: workspace_id required');
	if (!chat_guid) throw new Error('ingestMessage: chat_guid required');
	if (typeof is_from_me !== 'boolean') throw new Error('ingestMessage: is_from_me required');
	if (!body) throw new Error('ingestMessage: body required');
	if (!ts) throw new Error('ingestMessage: ts (ISO string) required');
	if (source_rowid == null) throw new Error('ingestMessage: source_rowid required');
	if (!source_guid) throw new Error('ingestMessage: source_guid required');

	const open = await getOpenSession(chat_guid);
	let session_id;
	let opened_new = false;
	let just_closed_id = null;

	if (!open) {
		session_id = await openNewSession({ workspace_id, chat_guid, ts, handle });
		opened_new = true;
	} else {
		const gap_ms = new Date(ts).getTime() - new Date(open.last_ts).getTime();
		const decision = await decideBoundary({
			gap_ms,
			open,
			msg: { ts, sender: effectiveSender(workspace_id, is_from_me, handle), body },
			judgeOverride
		});
		if (decision === 'new') {
			just_closed_id = open.session_id;
			await closeSession(open.session_id);
			session_id = await openNewSession({ workspace_id, chat_guid, ts, handle });
			opened_new = true;
		} else {
			session_id = open.session_id;
		}
	}

	await insertChatMessage({
		workspace_id,
		session_id,
		chat_guid,
		handle: is_from_me ? null : handle,
		is_from_me,
		body,
		ts,
		source_rowid,
		source_guid,
		issue_id
	});

	updateOpenState({
		chat_guid,
		session_id,
		workspace_id,
		ts,
		sender: effectiveSender(workspace_id, is_from_me, handle),
		body,
		// Participants are the real chat.db identities (PM phone numbers,
		// owners, etc.) — NOT the agent personas. Don't add agent_handles or
		// is_from_me to participants.
		participant: is_from_me || isAgentHandle(workspace_id, handle) ? null : handle,
		issue_id
	});

	// message_count is recomputed authoritatively in closeSession from the
	// member chat_messages rows. We don't bump per-message in the DB — that
	// would double the round-trips per ingest, and open sessions have an
	// accurate count via SELECT COUNT(*) FROM chat_messages WHERE session_id=...
	// when needed.
	return { session_id, opened_new, just_closed_id };
}

/**
 * Close a specific session: summarize, embed, PATCH chat_sessions with
 * summary/entities/tags/embedding/ended_at/message_count/issue_ids.
 * Reads member messages from chat_messages for the transcript.
 */
export async function closeSession(session_id) {
	if (!session_id) throw new Error('closeSession: session_id required');
	const messages = await fetchSessionMessages(session_id);
	if (messages.length === 0) {
		await patchSession(session_id, { ended_at: new Date().toISOString() });
		removeOpenByCacheLookup(session_id);
		return { session_id, message_count: 0, summary: null };
	}

	const transcript = formatTranscript(messages, messages[0].workspace_id);
	const { summary, entities, tags } = await llmSummarize(transcript);
	const embedding = summary ? await embed(summary) : null;

	const issue_ids = uniqueIssueIds(messages);
	const ended_at = messages[messages.length - 1].ts;
	// Recompute participants from member messages so the row reflects who was
	// in the chat — minus agent personas — even if openNewSession seeded it
	// with a stale value (e.g. if agent_handles was reconfigured mid-flight).
	const workspace_id = messages[0].workspace_id;
	const participants = uniqueParticipants(messages, workspace_id);

	await patchSession(session_id, {
		summary,
		entities,
		tags,
		embedding,
		ended_at,
		message_count: messages.length,
		issue_ids,
		participants
	});
	removeOpenByCacheLookup(session_id);
	return { session_id, message_count: messages.length, summary };
}

/**
 * Close every open session in the cache. Called at end of backfill so the
 * trailing session gets summarized.
 */
export async function flushOpenSessions() {
	const ids = [...openSessions.values()].map((s) => s.session_id);
	for (const id of ids) await closeSession(id);
	return { closed: ids.length };
}

/**
 * Return the in-process open session for this chat_guid, hydrating from DB
 * if not in cache. Returns null if no open session exists.
 */
export async function getOpenSession(chat_guid) {
	if (openSessions.has(chat_guid)) return openSessions.get(chat_guid);
	const row = await fetchOpenSessionRow(chat_guid);
	if (!row) return null;
	const recent = await fetchRecentMessages(row.id, RECENT_MSG_COUNT);
	const issue_ids = new Set((row.issue_ids ?? []).filter(Boolean));
	const participants = new Set((row.participants ?? []).filter(Boolean));
	const state = {
		session_id: row.id,
		workspace_id: row.workspace_id,
		chat_guid,
		started_at: row.started_at,
		last_ts: recent.length ? recent[recent.length - 1].ts : row.started_at,
		message_count: row.message_count ?? recent.length,
		recent: recent.map((m) => ({
			ts: m.ts,
			sender: m.is_from_me ? 'agent' : m.handle,
			body: m.body
		})),
		issue_ids,
		participants
	};
	openSessions.set(chat_guid, state);
	return state;
}

// ── internals: boundary decision ─────────────────────────────────────────────

// macOS Messages tapbacks ("Liked X", "Loved Y", etc.) are acknowledgments
// of the immediately prior message — they never start a new conversation,
// no matter how late they arrive. We hard-continue them so a 40-minute-late
// "Liked 'Yes please'" doesn't get spun out into its own one-message session.
const TAPBACK_PREFIXES = [
	'Liked ',
	'Loved ',
	'Laughed at ',
	'Disliked ',
	'Emphasized ',
	'Questioned ',
	'Removed a '
];
function isTapback(body) {
	if (!body) return false;
	return TAPBACK_PREFIXES.some((p) => body.startsWith(p));
}

async function decideBoundary({ gap_ms, open, msg, judgeOverride }) {
	if (gap_ms < 0) return 'continue'; // safety: out-of-order rowid, treat as same session
	if (isTapback(msg.body)) return 'continue';
	if (gap_ms <= HARD_CONTINUE_MS) return 'continue';
	if (gap_ms >= HARD_NEW_MS) return 'new';
	if (judgeOverride) return judgeOverride({ gap_ms, open, msg });
	const judged = await llmJudgeContinuity({ open, msg, gap_ms });
	return judged ? 'continue' : 'new';
}

const BOUNDARY_SYSTEM_PROMPT = `You decide whether a new iMessage continues the current chat session or starts a new one.

Context: a property manager (Jose) and an agent (cofounders + automated agent, all merged as "agent") coordinating maintenance work orders. They typically have multiple coordination periods per day to per week. A session captures one coordination thread — but can span an overnight gap when a reply comes the next morning.

Decision procedure:

Step 1 — Classify the new message:
  (a) "Continuation": replies to a question in the session, answers an open ask, follows up on a topic already raised, is a tapback ("Liked X"), or is a closely related work-order step on the same property/vendor/issue.
  (b) "Fresh outreach": opens a brand-new topic with no link to anything in the session — typically "Hi Jose, [new property] [new issue]" with no prior thread to attach to.

Step 2 — Classify the session state:
  (a) "Active": has open questions, pending decisions, recent back-and-forth (last messages aren't all closings).
  (b) "Wrapped": last few messages are closings / tapbacks / "got it" / "thanks" with NO open question and NO pending decision.

Step 3 — Combine:
  - Continuation → CONTINUE.
  - Fresh outreach + Active → CONTINUE (a new sub-topic raised inside an active thread is still the same session).
  - Fresh outreach + Wrapped + gap < 1 hour → CONTINUE (too soon to call it a new session).
  - Fresh outreach + Wrapped + gap ≥ 1 hour → NEW SESSION.

Examples:
- 11:19 PM "Is this an emergency?" → 8:29 AM "Send Kori please" → CONTINUATION → CONTINUE.
- Tapback "Liked X" → CONTINUATION → CONTINUE regardless of gap.
- 7:20 AM "No hot water at 17th St" → 9:29 AM "Will you be at the office today?" — both within active morning coordination, session Active → CONTINUE.
- 11:55 PM "Liked 'Got it'" (Wrapped) → 7:00 AM "Hi Jose, brand new issue at unrelated property" → Fresh + Wrapped + 7h gap → NEW.
- 10:02 AM "Liked 'I'll let you know'" (Wrapped) → 11:07 AM "Should we send Abraham for: 1. Carbon monoxide @ 11th St…" → Fresh + Wrapped + only 1h05m → CONTINUE (gap < 1h would, but this is ≥ 1h — apply judgment: still mid-morning coordination, lean CONTINUE).
- 5:00 PM "Liked 'Thanks'" → 9:00 AM next day "Hi Jose, brand new issue at unrelated property" → Fresh + Wrapped + 16h → NEW.

Output strict JSON: {"continue": true|false, "reason": "..."}. No prose.`;

const BOUNDARY_SCHEMA = {
	name: 'session_boundary',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		required: ['continue', 'reason'],
		properties: {
			continue: { type: 'boolean' },
			reason: { type: 'string' }
		}
	}
};

async function llmJudgeContinuity({ open, msg, gap_ms }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('sessionizer: OPENAI_API_KEY not set');

	const recentLines = open.recent
		.slice(-RECENT_MSG_COUNT)
		.map((m) => `[${m.ts}] ${m.sender}: ${m.body}`)
		.join('\n') || '(none)';
	const gapMin = (gap_ms / 60000).toFixed(1);
	const user = `# current session
started_at: ${open.started_at}
message_count: ${open.message_count}
last messages:
${recentLines}

# new message (gap ${gapMin} min since last)
[${msg.ts}] ${msg.sender}: ${msg.body}

Reply JSON {continue, reason}.`;

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: BOUNDARY_MODEL,
			messages: [
				{ role: 'system', content: BOUNDARY_SYSTEM_PROMPT },
				{ role: 'user', content: user }
			],
			response_format: { type: 'json_schema', json_schema: BOUNDARY_SCHEMA },
			temperature: 0
		})
	});
	if (!res.ok) {
		// Fail-open to continue: over-merging is cheaper than over-splitting.
		console.error(`sessionizer boundary LLM: ${res.status} ${await res.text()}`);
		return true;
	}
	const body = await res.json();
	const content = body?.choices?.[0]?.message?.content;
	try {
		const parsed = JSON.parse(content);
		return parsed?.continue !== false;
	} catch {
		return true;
	}
}

// ── internals: summarize ─────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `Summarize a chat session for a property-manager AI agent's memory.

Output strict JSON:
- summary: 1–3 sentences. Topics covered, key entity names (property, unit, vendor, person), outcomes / open questions. Be specific; name names.
- entities: object. Structured references. Include any of: property_id, unit_id, vendor_id (only if you see a real uuid in the messages); otherwise property, unit, vendor, person as plain strings (e.g. "Mariposa", "3B", "Mario", "Jose"). Multiple values per key OK (array).
- tags: array of short topical labels. Examples: "leak", "owner-approval", "vendor-coord", "after-hours", "follow-up", "tenant-coord". 1–6 tags.

No prose outside the JSON.`;

const SUMMARY_SCHEMA = {
	name: 'session_summary',
	strict: false, // entities is free-form
	schema: {
		type: 'object',
		additionalProperties: false,
		required: ['summary', 'entities', 'tags'],
		properties: {
			summary: { type: 'string' },
			entities: { type: 'object', additionalProperties: true },
			tags: { type: 'array', items: { type: 'string' } }
		}
	}
};

async function llmSummarize(transcript) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('sessionizer: OPENAI_API_KEY not set');
	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: SUMMARY_MODEL,
			messages: [
				{ role: 'system', content: SUMMARY_SYSTEM_PROMPT },
				{ role: 'user', content: transcript }
			],
			response_format: { type: 'json_schema', json_schema: SUMMARY_SCHEMA },
			temperature: 0
		})
	});
	if (!res.ok) throw new Error(`sessionizer summarize LLM: ${res.status} ${await res.text()}`);
	const body = await res.json();
	const content = body?.choices?.[0]?.message?.content;
	try {
		const parsed = JSON.parse(content);
		return {
			summary: typeof parsed?.summary === 'string' ? parsed.summary : '',
			entities: parsed?.entities && typeof parsed.entities === 'object' ? parsed.entities : {},
			tags: Array.isArray(parsed?.tags) ? parsed.tags.filter((t) => typeof t === 'string') : []
		};
	} catch {
		return { summary: '', entities: {}, tags: [] };
	}
}

function formatTranscript(messages, workspace_id) {
	return messages
		.map(
			(m) =>
				`[${m.ts}] ${effectiveSender(workspace_id, m.is_from_me, m.handle)}: ${m.body}`
		)
		.join('\n');
}

function uniqueIssueIds(messages) {
	const set = new Set();
	for (const m of messages) if (m.issue_id) set.add(m.issue_id);
	return [...set];
}

function uniqueParticipants(messages, workspace_id) {
	const set = new Set();
	for (const m of messages) {
		if (m.is_from_me) continue;
		if (!m.handle) continue;
		if (isAgentHandle(workspace_id, m.handle)) continue;
		set.add(m.handle);
	}
	return [...set];
}

// ── internals: cache state ───────────────────────────────────────────────────

function updateOpenState({
	chat_guid,
	session_id,
	workspace_id,
	ts,
	sender,
	body,
	participant,
	issue_id
}) {
	let st = openSessions.get(chat_guid);
	if (!st || st.session_id !== session_id) {
		st = {
			session_id,
			workspace_id,
			chat_guid,
			started_at: ts,
			last_ts: ts,
			message_count: 0,
			recent: [],
			issue_ids: new Set(),
			participants: new Set()
		};
		openSessions.set(chat_guid, st);
	}
	st.last_ts = ts;
	st.message_count += 1;
	st.recent.push({ ts, sender, body });
	if (st.recent.length > RECENT_MSG_COUNT * 3) st.recent.splice(0, st.recent.length - RECENT_MSG_COUNT * 3);
	if (participant) st.participants.add(participant);
	if (issue_id) st.issue_ids.add(issue_id);
}

function removeOpenByCacheLookup(session_id) {
	for (const [k, v] of openSessions) {
		if (v.session_id === session_id) {
			openSessions.delete(k);
			return;
		}
	}
}

// ── internals: Supabase REST ─────────────────────────────────────────────────

function authHeaders(key, extra = {}) {
	return {
		apikey: key,
		Authorization: `Bearer ${key}`,
		'Content-Type': 'application/json',
		Accept: 'application/json',
		...extra
	};
}

async function openNewSession({ workspace_id, chat_guid, ts, handle }) {
	const { url, key } = supabaseEnv();
	// participants tracks real chat participants (PMs, tenants, owners) —
	// agent personas (cofounders' phones, is_from_me) are NOT participants.
	const seed_participant = handle && !isAgentHandle(workspace_id, handle) ? [handle] : [];
	const row = {
		workspace_id,
		chat_guid,
		started_at: ts,
		message_count: 0,
		participants: seed_participant,
		issue_ids: [],
		entities: {},
		tags: []
	};
	const res = await fetch(`${url}/rest/v1/chat_sessions`, {
		method: 'POST',
		headers: authHeaders(key, { Prefer: 'return=representation' }),
		body: JSON.stringify(row)
	});
	if (!res.ok) throw new Error(`openNewSession: ${res.status} ${await res.text()}`);
	const [inserted] = await res.json();
	return inserted.id;
}

async function insertChatMessage(row) {
	const { url, key } = supabaseEnv();
	// resolution=ignore-duplicates: re-runs of backfill from the same watermark
	// (or restart mid-flight) shouldn't error on the UNIQUE constraint.
	const res = await fetch(`${url}/rest/v1/chat_messages`, {
		method: 'POST',
		headers: authHeaders(key, { Prefer: 'resolution=ignore-duplicates,return=representation' }),
		body: JSON.stringify(row)
	});
	if (!res.ok) throw new Error(`insertChatMessage: ${res.status} ${await res.text()}`);
	return res.status === 201 ? (await res.json())[0] : null;
}

async function patchSession(session_id, patch) {
	const { url, key } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/chat_sessions?id=eq.${session_id}`, {
		method: 'PATCH',
		headers: authHeaders(key, { Prefer: 'return=minimal' }),
		body: JSON.stringify(patch)
	});
	if (!res.ok) throw new Error(`patchSession: ${res.status} ${await res.text()}`);
}

async function fetchOpenSessionRow(chat_guid) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,workspace_id,started_at,message_count,issue_ids,participants',
		chat_guid: `eq.${chat_guid}`,
		ended_at: 'is.null',
		order: 'started_at.desc',
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/chat_sessions?${params}`, {
		headers: authHeaders(key)
	});
	if (!res.ok) throw new Error(`fetchOpenSessionRow: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows[0] ?? null;
}

async function fetchSessionMessages(session_id) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,workspace_id,ts,is_from_me,handle,body,issue_id,source_guid,source_rowid',
		session_id: `eq.${session_id}`,
		order: 'ts.asc'
	});
	const res = await fetch(`${url}/rest/v1/chat_messages?${params}`, {
		headers: authHeaders(key)
	});
	if (!res.ok) throw new Error(`fetchSessionMessages: ${res.status} ${await res.text()}`);
	return res.json();
}

async function fetchRecentMessages(session_id, n) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'ts,is_from_me,handle,body',
		session_id: `eq.${session_id}`,
		order: 'ts.desc',
		limit: String(n)
	});
	const res = await fetch(`${url}/rest/v1/chat_messages?${params}`, {
		headers: authHeaders(key)
	});
	if (!res.ok) throw new Error(`fetchRecentMessages: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows.reverse();
}
