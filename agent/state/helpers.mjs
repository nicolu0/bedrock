// Data access layer for agent state.
//
// All reads/writes to the JSON files in this directory go through here.
// Writes are atomic: write to <name>.tmp, then rename — a crash mid-write
// leaves the previous good file in place.
//
// When we move from local JSON to Supabase, only this file changes.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchIssueById } from '../core/supabase.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// State directory can be overridden via BEDROCK_STATE_DIR — used by the eval
// harness so test runs don't trample real drafts/logs. Defaults to this
// module's own directory (the prod state files).
const STATE_DIR = process.env.BEDROCK_STATE_DIR || __dirname;

const FILES = {
	drafts: path.join(STATE_DIR, 'drafts.json'),
	sent: path.join(STATE_DIR, 'sent-log.json'),
	response: path.join(STATE_DIR, 'response-log.json'),
	chat: path.join(STATE_DIR, 'chat-log.json'),
	issuesCursor: path.join(STATE_DIR, 'issues-cursor.json'),
	chatCursor: path.join(STATE_DIR, 'chat-cursor.json')
};

async function readJson(file, fallback) {
	try {
		const raw = await fs.readFile(file, 'utf8');
		return raw.trim() === '' ? fallback : JSON.parse(raw);
	} catch (err) {
		if (err.code === 'ENOENT') return fallback;
		throw err;
	}
}

async function writeJsonAtomic(file, value) {
	const tmp = `${file}.tmp`;
	const data = JSON.stringify(value, null, 2) + '\n';
	await fs.writeFile(tmp, data, 'utf8');
	await fs.rename(tmp, file);
}

// Serialize writes per-file so concurrent callers don't clobber each other.
const writeQueues = new Map();
function withLock(file, fn) {
	const prev = writeQueues.get(file) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	writeQueues.set(
		file,
		next.catch(() => {})
	);
	return next;
}

function newId(prefix) {
	return `${prefix}_${randomBytes(8).toString('hex')}`;
}

// ─── drafts ────────────────────────────────────────────────────────────────

export async function loadDrafts() {
	return readJson(FILES.drafts, []);
}

export async function createDraft(record) {
	return withLock(FILES.drafts, async () => {
		const drafts = await readJson(FILES.drafts, []);
		const draft = {
			id: newId('drf'),
			created_at: new Date().toISOString(),
			hold_until: null,
			...record
		};
		// Snapshot the agent's first output so edits don't erase the signal.
		// Mutable `messages` is what the human edits; `original_messages` is
		// what response-log compares against to compute diffs.
		if (Array.isArray(draft.messages) && !Array.isArray(draft.original_messages)) {
			draft.original_messages = draft.messages.map((m) => ({ body: m.body }));
		}
		drafts.push(draft);
		await writeJsonAtomic(FILES.drafts, drafts);
		return draft;
	});
}

export async function updateDraft(id, patch) {
	return withLock(FILES.drafts, async () => {
		const drafts = await readJson(FILES.drafts, []);
		const i = drafts.findIndex((d) => d.id === id);
		if (i === -1) return null;
		drafts[i] = { ...drafts[i], ...patch };
		await writeJsonAtomic(FILES.drafts, drafts);
		return drafts[i];
	});
}

export async function removeDraft(id) {
	return withLock(FILES.drafts, async () => {
		const drafts = await readJson(FILES.drafts, []);
		const next = drafts.filter((d) => d.id !== id);
		await writeJsonAtomic(FILES.drafts, next);
		return drafts.length !== next.length;
	});
}

// Atomically claim a draft for a LIVE AppFolio send so it can fire exactly once.
// The actual send happens in the Playwright runner, which the UI triggers
// fire-and-forget — so a re-click (or a UI false-negative) could otherwise fire a
// second real send. The claim is the chokepoint: undefined/'idle' → 'sending'
// (granted); already 'sending' or 'sent' → refused. A genuine pre-send failure
// calls releaseDraftSend to reopen it; a completed send removes the draft. Atomic
// via the drafts file lock, so two racing clicks can't both win.
export async function claimDraftSend(id) {
	return withLock(FILES.drafts, async () => {
		const drafts = await readJson(FILES.drafts, []);
		const i = drafts.findIndex((d) => d.id === id);
		if (i === -1) return { ok: false, reason: 'not_found' };
		const cur = drafts[i].send_state;
		if (cur === 'sending' || cur === 'sent') return { ok: false, reason: cur, draft: drafts[i] };
		drafts[i] = { ...drafts[i], send_state: 'sending', send_claimed_at: new Date().toISOString() };
		await writeJsonAtomic(FILES.drafts, drafts);
		return { ok: true, draft: drafts[i] };
	});
}

// Reopen a claimed draft after a genuine failure so the human can retry. Only
// touches a draft still in 'sending' — never resurrects one already 'sent' (the
// text went out) or removed.
export async function releaseDraftSend(id) {
	return withLock(FILES.drafts, async () => {
		const drafts = await readJson(FILES.drafts, []);
		const i = drafts.findIndex((d) => d.id === id);
		if (i === -1) return null;
		if (drafts[i].send_state !== 'sending') return drafts[i];
		drafts[i] = { ...drafts[i], send_state: 'idle', send_claimed_at: null };
		await writeJsonAtomic(FILES.drafts, drafts);
		return drafts[i];
	});
}

// ─── append-only logs ──────────────────────────────────────────────────────

export async function appendSent(entry) {
	return withLock(FILES.sent, async () => {
		const log = await readJson(FILES.sent, []);
		const row = { sent_at: new Date().toISOString(), ...entry };
		log.push(row);
		await writeJsonAtomic(FILES.sent, log);
		return row;
	});
}

export async function loadSent() {
	return readJson(FILES.sent, []);
}

// The issue_id we attached to a groupchat send with this exact body, if any.
// chat.db carries no issue linkage, so when the poller reads our own send back
// it uses this to stamp issue_id onto the matching outbound chat_messages row —
// which is what lets a closed session's `issue_ids` (and the live open-session
// scoping) know which work orders it touched. Matches on chat_guid + body
// (byte-identical between what we logged and what landed in Messages);
// most-recent match wins. Returns null for sends that carry no issue_id (acks,
// clarifying questions) or when nothing matches.
export async function sentIssueIdForBody({ chat_guid, body } = {}) {
	if (!chat_guid || !body) return null;
	const target = String(body).trim();
	const all = await readJson(FILES.sent, []);
	for (let i = all.length - 1; i >= 0; i--) {
		const row = all[i];
		if (row.channel !== 'groupchat' || row.chat_guid !== chat_guid || !row.issue_id) continue;
		if (String(row.body ?? '').trim() === target) return row.issue_id;
	}
	return null;
}

export async function appendResponse(entry) {
	return withLock(FILES.response, async () => {
		const log = await readJson(FILES.response, []);
		const row = { timestamp: new Date().toISOString(), ...entry };
		log.push(row);
		await writeJsonAtomic(FILES.response, log);
		return row;
	});
}

export async function loadResponses() {
	return readJson(FILES.response, []);
}

// ─── inbound chat log ──────────────────────────────────────────────────────
// One row per incoming iMessage we observe in a mapped groupchat (F2). The
// correlator later overlays sent-log entries by `message_guid` to know which
// of our outbound messages each PM reply is responding to.

export async function appendChatMessage(entry) {
	return withLock(FILES.chat, async () => {
		const log = await readJson(FILES.chat, []);
		const row = { received_at: new Date().toISOString(), ...entry };
		log.push(row);
		await writeJsonAtomic(FILES.chat, log);
		return row;
	});
}

export async function loadChatMessages() {
	return readJson(FILES.chat, []);
}

// Patch a chat-log row in place by message_guid. Used by the chat poller
// after running the chat skill to record what the agent did with this
// message (drafted / no_match / failure). Mutating an "append-only" log
// is a deliberate exception — the patch is metadata about agent processing,
// not the message itself.
export async function updateChatMessage(messageGuid, patch) {
	return withLock(FILES.chat, async () => {
		const log = await readJson(FILES.chat, []);
		const i = log.findIndex((m) => m.message_guid === messageGuid);
		if (i === -1) return null;
		log[i] = { ...log[i], ...patch };
		await writeJsonAtomic(FILES.chat, log);
		return log[i];
	});
}

// Issue ids that have already been ack'd by the chat skill (i.e. have an
// existing tenant_appfolio or vendor_appfolio draft, pending or processed).
// Used by recentSentForChat to exclude already-handled issues from the
// candidate list so the model doesn't get ambiguous yes-replies.
async function alreadyDraftedFollowupIds() {
	const FOLLOWUP_CHANNELS = new Set(['tenant_appfolio', 'vendor_appfolio']);
	const [drafts, responses] = await Promise.all([
		readJson(FILES.drafts, []),
		readJson(FILES.response, [])
	]);
	const ids = new Set();
	for (const d of drafts) {
		if (d.issue_id && FOLLOWUP_CHANNELS.has(d.channel)) ids.add(d.issue_id);
	}
	for (const r of responses) {
		if (r.issue_id && FOLLOWUP_CHANNELS.has(r.channel)) ids.add(r.issue_id);
	}
	return ids;
}

// Drop all rows for a given workspace_label across drafts/sent/response/chat
// logs, plus reset the issues cursor's processedIds so freshly-inserted test
// issues fire again. Returns a per-file summary of how many rows were dropped.
export async function clearWorkspaceLocalState(workspace_label) {
	if (!workspace_label) throw new Error('clearWorkspaceLocalState: workspace_label required');
	const summary = {};
	const files = [
		['drafts', FILES.drafts],
		['sent', FILES.sent],
		['response', FILES.response],
		['chat', FILES.chat]
	];
	for (const [name, file] of files) {
		await withLock(file, async () => {
			const rows = await readJson(file, []);
			const kept = rows.filter((r) => r.workspace_label !== workspace_label);
			summary[name] = { before: rows.length, after: kept.length };
			await writeJsonAtomic(file, kept);
		});
	}
	// Reset the issues cursor so a fresh insert fires again. We don't
	// per-workspace-filter this — processedIds is small enough that a full
	// reset is fine, and it's only triggered by an explicit clear action.
	await withLock(FILES.issuesCursor, async () => {
		const cursor = await readJson(FILES.issuesCursor, {});
		cursor.processedIds = {};
		cursor.lastCheckedAt = new Date().toISOString();
		await writeJsonAtomic(FILES.issuesCursor, cursor);
	});
	return summary;
}

// Recent groupchat sends for a given chat. The chat skill's buildContext
// uses this to construct the candidate-issues list — these are the open
// work orders we've recently texted the PM about, which is what they're
// likely replying to.
//
// Filters by chat_guid so we only see candidates from THIS chat. Also
// excludes issues that already have tenant/vendor drafts — once the chat
// skill has acted on an issue, it shouldn't show up as a candidate again
// (otherwise a later "yes" gets ambiguous between the new send and the
// already-handled one).
//
// Work-order lifecycle states that mean "no longer an open candidate the PM
// could be replying to". Mirrors the issues_v2 status enum written by
// update_issue. `new` and `awaiting_pm` (and unknown) remain candidates.
const RESOLVED_STATUSES = new Set([
	'triaging',
	'dispatched',
	'scheduled',
	'pm_handling',
	'completed'
]);

// Filter candidate bundles to those whose issue is still open. Reads
// issues_v2.status per candidate (parallel). Best-effort: a missing status
// (eval fixtures without one) or a fetch error keeps the candidate — fail-open,
// so this can only ever REMOVE known-resolved WOs, never hide an open one.
async function filterOpenByStatus(bundles) {
	const checked = await Promise.all(
		bundles.map(async (b) => {
			try {
				const issue = await fetchIssueById(b.issue_id);
				return RESOLVED_STATUSES.has(issue?.status ?? null) ? null : b;
			} catch {
				return b;
			}
		})
	);
	return checked.filter(Boolean);
}

// withinMs defaults to 7 days. limit defaults to 5. sessionSendBodies, when
// provided, scopes candidates to the live session by MEMBERSHIP: a sent summary
// counts only if its text is among the open session's outbound messages — so a
// fresh "yes" can't attach to a stale WO from a prior conversation. Matching on
// text (not the sent-log timestamp vs the session's read-back start) avoids the
// ~100ms cross-store skew that dropped a session-opening WO from its own
// session. Null/absent (eval, no open session) = flat 7-day window, no scoping.
export async function recentSentForChat({
	chat_guid,
	withinMs = 7 * 24 * 60 * 60 * 1000,
	limit = 5,
	sessionSendBodies = null
} = {}) {
	if (!chat_guid) return [];
	const [all, drafted] = await Promise.all([
		readJson(FILES.sent, []),
		alreadyDraftedFollowupIds()
	]);
	const cutoff = Date.now() - withinMs;
	const matches = all.filter((row) => {
		if (row.channel !== 'groupchat') return false;
		if (row.chat_guid !== chat_guid) return false;
		// Only work-order summaries are candidates. Clarifying questions / acks we
		// sent are also channel 'groupchat' but carry no issue_id — they must not
		// show up as phantom candidates the PM could be "replying to".
		if (!row.issue_id) return false;
		const sentAt = row.sent_at ? new Date(row.sent_at).getTime() : 0;
		if (sentAt < cutoff) return false;
		// Scope to the live session by MEMBERSHIP, not timestamp: keep a send only
		// if its text is among the open session's outbound messages. Null (eval / no
		// open session) = no session scoping, just the flat window above.
		if (sessionSendBodies && !sessionSendBodies.has(String(row.body ?? '').trim())) return false;
		return true;
	});
	// Bundle by bundle_id (one F1 turn = one bundle = one issue), keep most
	// recent N bundles. Caller wants candidate issues, not raw messages.
	const seen = new Map(); // bundle_id -> { bundle_id, issue_id, sent_at, bodies[] }
	for (const row of matches) {
		const key = row.bundle_id ?? row.message_guid;
		if (!seen.has(key)) {
			seen.set(key, { bundle_id: key, issue_id: row.issue_id, sent_at: row.sent_at, bodies: [] });
		}
		seen.get(key).bodies.push(row.body);
	}
	let open = [...seen.values()].filter((b) => !drafted.has(b.issue_id));
	// Drop work orders whose lifecycle has advanced past "open candidate". The PM
	// has already responded to these (we dispatched, they self-handled, we're
	// triaging, etc.), so a fresh "yes" can't be approving them — leaving them in
	// is what produced phantom candidates and spurious clarifying questions.
	open = await filterOpenByStatus(open);
	const bundles = open
		.sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())
		.slice(0, limit);
	// Present oldest-first so the candidate list mirrors the order the PM sees the
	// work orders in the chat. Keeps positional references ("the second one")
	// consistent across what the PM reads, the clarifying question we list, and
	// the candidate numbering — they'd otherwise disagree (newest-first vs chat).
	bundles.reverse();
	return bundles;
}

export async function updateResponse(draftId, patch) {
	return withLock(FILES.response, async () => {
		const log = await readJson(FILES.response, []);
		const i = log.findIndex((r) => r.draft_id === draftId);
		if (i === -1) return null;
		log[i] = { ...log[i], ...patch };
		await writeJsonAtomic(FILES.response, log);
		return log[i];
	});
}

// ─── cursors ───────────────────────────────────────────────────────────────

const CURSOR_FILES = {
	issues: FILES.issuesCursor,
	chat: FILES.chatCursor
};

export async function loadCursor(name) {
	const file = CURSOR_FILES[name];
	if (!file) throw new Error(`unknown cursor: ${name}`);
	return readJson(file, {});
}

export async function saveCursor(name, value) {
	const file = CURSOR_FILES[name];
	if (!file) throw new Error(`unknown cursor: ${name}`);
	return withLock(file, () => writeJsonAtomic(file, value));
}
