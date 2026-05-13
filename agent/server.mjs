#!/usr/bin/env node
// Main server entrypoint. Stands up the IPC listener (via the imessage helper),
// watches chat.db for incoming messages from unknown numbers, hands each one to
// the orchestrator, and maps the orchestrator's event stream to real iMessage
// signals via the injected MessagesHelper bundle:
//   read        -> markRead(chatGuid)        (Read receipt on the sender's phone)
//   typing      -> setTyping(chatGuid, true) (the "..." dots)
//   message     -> setTyping(false) + send via dylib
//   tool_call   -> just log
//
// Setup prerequisites are documented in imessage/README.md. Run:
//   agent/imessage/run-messages.sh    # in one terminal
//   node agent/server.mjs             # in another

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { helper } from './imessage/helper.mjs';
import { runTurn } from './core/orchestrator.mjs';
import { startUi } from './work-orders/ui/index.mjs';
import { startIssuePoller } from './work-orders/issue-poller.mjs';
import { buildChatGuidIndex } from './work-orders/workspaces.mjs';
import { appendChatMessage } from './work-orders/state/helpers.mjs';

const POLL_INTERVAL_MS = 1000;
const HELPER_ENABLED = process.env.HELPER_DISABLED !== '1';
const DEMO_HANDLE = process.env.DEMO_HANDLE ? normalizeHandle(process.env.DEMO_HANDLE) : null;

// Simulated typing pace: dots stay on for this long before each message ships.
// Scales with message length so a 4-word reply doesn't feel as instant as a
// 30-word one. Tuned to feel snappy but not robotic — adjust to taste.
const TYPING_MIN_MS = 300;
const TYPING_PER_CHAR_MS = 25;
const TYPING_MAX_MS = 2000;

function typingDwellMs(text) {
	const n = (text ?? '').length;
	return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, n * TYPING_PER_CHAR_MS));
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const STATE_PATH = path.join(SCRIPT_DIR, '.imessage-state.json');

// Real customer/vendor handles — incoming messages from these are ignored so
// testing doesn't hijack real conversations. E.164 phone numbers or email.
const KNOWN_NUMBERS = [
	'+13106990643', // Jose / property manager
	'+13102663152', // Jose (other number)
];
const knownSet = new Set(KNOWN_NUMBERS.map(normalizeHandle));

// ── Env ────────────────────────────────────────────────────────────────────────

async function loadDotEnv(p) {
	try {
		const raw = await fs.readFile(p, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith('#')) continue;
			const i = t.indexOf('=');
			if (i <= 0) continue;
			const k = t.slice(0, i).trim();
			let v = t.slice(i + 1).trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
			if (!(k in process.env)) process.env[k] = v;
		}
	} catch { /* optional */ }
}

await loadDotEnv(path.join(SCRIPT_DIR, '..', '.env'));
await loadDotEnv(path.join(SCRIPT_DIR, '.env'));

if (!process.env.OPENAI_API_KEY) {
	console.log('OPENAI_API_KEY not set — checked .env in repo root and agent/');
	process.exit(1);
}

// ── Workspace routing ──────────────────────────────────────────────────────────
//
// chatGuidIndex maps mapped chat guids (TEST_CHAT_GUID, JOSE_CHAT_GUID) to
// { workspace_id, label, pm_handles }. Built once after env load. Any incoming
// chat.db row whose chat_guid is in this index is treated as a work-orders
// groupchat message (not demo), and we only store messages from pm_handles.
let chatGuidIndex = new Map();
let groupchatGuids = [];

// ── State ──────────────────────────────────────────────────────────────────────

const state = { lastSeenRowId: 0, processed: {} };

async function loadState() {
	try {
		const raw = await fs.readFile(STATE_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		state.lastSeenRowId = Number(parsed.lastSeenRowId ?? 0);
		state.processed = parsed.processed ?? {};
	} catch {
		state.lastSeenRowId = fetchLatestRowId();
		state.processed = {};
		await saveState();
	}
}

async function saveState() {
	const entries = Object.entries(state.processed).sort((a, b) => b[1] - a[1]);
	state.processed = Object.fromEntries(entries.slice(0, 2000));
	await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg) {
	console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function shortHandle(h) {
	if (!h) return h;
	if (h.includes('@')) return h; // emails: leave intact, letters and all
	return h.replace(/^\+1/, '').replace(/[^\d@.]/g, '') || h;
}

function normalizeHandle(raw) {
	if (!raw) return '';
	const value = String(raw).trim();
	if (!value) return '';
	if (value.includes('@')) return value.toLowerCase();
	const digitsOnly = value.replace(/[^\d+]/g, '');
	if (digitsOnly.startsWith('+')) return `+${digitsOnly.slice(1).replace(/\D/g, '')}`;
	const digits = digitsOnly.replace(/\D/g, '');
	if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
	if (digits.length === 10) return `+1${digits}`;
	if (digits.length > 0) return `+${digits}`;
	return value.toLowerCase();
}

// ── chat.db ────────────────────────────────────────────────────────────────────

let db = null;

function getDb() {
	if (!db) db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
	return db;
}

// macOS Ventura+ stores message text in attributedBody (NSAttributedString
// streamtyped binary). Lift the plain UTF-8 string out.
function extractText(row) {
	if (row.text) return row.text;
	const blob = row.attributedBody;
	if (!blob || !Buffer.isBuffer(blob)) return null;
	let i = 0;
	while (i < blob.length) {
		if (blob[i] === 0x2b) {
			i++;
			if (i >= blob.length) break;
			let len;
			if (blob[i] === 0x84 && i + 2 < blob.length) {
				len = (blob[i + 1] << 8) | blob[i + 2];
				i += 3;
			} else {
				len = blob[i];
				i++;
			}
			if (len > 0 && i + len <= blob.length) {
				const candidate = blob.slice(i, i + len).toString('utf8');
				if (!candidate.includes('\x00') && !/^NS[A-Z]/.test(candidate)) return candidate;
			}
		} else {
			i++;
		}
	}
	return null;
}

function fetchLatestRowId() {
	try {
		const row = getDb().prepare('SELECT COALESCE(MAX(ROWID),0) AS max_rowid FROM message').get();
		return Number(row?.max_rowid ?? 0);
	} catch (err) {
		log(`db error: ${err.message}`);
		return 0;
	}
}

// SQL accepts two kinds of rows:
//   1) 1:1 direct messages (style 45, no room_name) — demo path.
//   2) Any chat whose guid is in `groupchatGuids` — F2 work-orders path.
// The IN-list is built from the chatGuidIndex so it picks up TEST_CHAT_GUID
// and JOSE_CHAT_GUID without having to special-case style 43 vs 45.
function fetchNewMessages(afterRowId, groupchatGuids) {
	try {
		const placeholders = groupchatGuids.map(() => '?').join(',');
		const groupBranch = placeholders ? `OR c.guid IN (${placeholders})` : '';
		const sql = `
			SELECT
			  m.ROWID AS rowid,
			  m.guid,
			  m.text,
			  m.attributedBody,
			  m.date,
			  m.is_from_me,
			  m.service,
			  COALESCE(m.cache_has_attachments, 0) AS has_attachments,
			  h.id AS handle,
			  c.guid AS chat_guid,
			  c.style AS chat_style,
			  c.room_name AS room_name
			FROM message m
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			LEFT JOIN chat c ON c.ROWID = cmj.chat_id
			WHERE m.ROWID > ?
			  AND m.service = 'iMessage'
			  AND COALESCE(m.cache_has_attachments, 0) = 0
			  AND (
			    (c.style = 45 AND c.room_name IS NULL)
			    ${groupBranch}
			  )
			ORDER BY m.ROWID ASC
			LIMIT 100
		`;
		const rows = getDb().prepare(sql).all(Number(afterRowId) || 0, ...groupchatGuids);
		return rows.map(r => ({ ...r, text: extractText(r) }));
	} catch (err) {
		log(`db error: ${err.message}`);
		return [];
	}
}

// ── Helper signals ─────────────────────────────────────────────────────────────

async function markRead(chatGuid) {
	if (!HELPER_ENABLED) return;
	const r = await helper.markRead(chatGuid);
	if (!r.ok) log(`markRead failed: ${r.error}`);
}

async function setTyping(chatGuid, typing) {
	if (!HELPER_ENABLED) return;
	const r = await helper.setTyping(chatGuid, typing);
	if (!r.ok) log(`setTyping(${typing}) failed: ${r.error}`);
}

// ── Send ───────────────────────────────────────────────────────────────────────

async function sendPart(chatGuid, _handle, text) {
	const r = await helper.send(chatGuid, text);
	if (!r.ok) log(`send failed: ${r.error}`);
	return r.ok;
}

// ── Main flow per incoming message ─────────────────────────────────────────────

async function handleIncoming(row) {
	const handle = normalizeHandle(row.handle);
	const chatGuid = row.chat_guid || '';
	const text = String(row.text || '').trim();
	if (!text) return;
	if (DEMO_HANDLE && handle !== DEMO_HANDLE) return;
	if (knownSet.has(handle)) return;

	log(`← ${shortHandle(handle)}: "${text}"`);

	// Dots come on ONLY immediately before a real message ships — never on
	// the orchestrator's `typing` event itself. The orchestrator emits a
	// typing event at the start of every iteration including the final
	// no-op one (where the model returns no more tool calls), so reacting to
	// that event causes a ghost flash. Tying dots to actual messages mirrors
	// how real iMessage typing indicators behave: you don't see "..." while
	// the other person is just thinking, you see them when they're actively
	// composing the next bubble.
	const onEvent = async (ev) => {
		if (ev.type === 'read') {
			await markRead(chatGuid);
		} else if (ev.type === 'typing') {
			// Intentional no-op. See above.
		} else if (ev.type === 'message') {
			await setTyping(chatGuid, true);
			await sleep(typingDwellMs(ev.content));
			await setTyping(chatGuid, false);
			const ok = await sendPart(chatGuid, handle, ev.content);
			if (ok) log(`→ ${shortHandle(handle)}: "${ev.content}"`);
		} else if (ev.type === 'tool_call') {
			const args = JSON.stringify(ev.args ?? {});
			log(`  · ${ev.name}(${args.length > 80 ? args.slice(0, 77) + '...' : args})`);
		}
	};

	// react closure for the orchestrator's react_to_message tool. Bound to this
	// specific incoming message — the LLM doesn't need to know GUIDs.
	const react = async (reactionType) => {
		if (!HELPER_ENABLED) return { ok: false, error: 'helper disabled' };
		const r = await helper.react(chatGuid, row.guid, reactionType, text);
		if (!r.ok) log(`react(${reactionType}) failed: ${r.error}`);
		else log(`  · react ${reactionType} -> "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`);
		return r;
	};

	try {
		await runTurn({
			trigger: 'inbound_message',
			ctx: { mode: 'demo', chatGuid, react, onEvent },
			input: { handle, text }
		});
	} catch (err) {
		log(`turn error: ${err.message}`);
	} finally {
		// Defensive: kill dots in case anything left them on (e.g., we threw
		// during the dwell sleep before the typing-off call).
		await setTyping(chatGuid, false);
	}
}

// ── Groupchat (work-orders) message capture ────────────────────────────────────
//
// For F2 step 1 we just append PM-handle messages to chat-log.json. The
// correlator (later step) reads from this log + sent-log to figure out which
// open issue a PM reply is about. Tenant/owner replies in the same chat are
// silently dropped — pm_handles is the gate.
async function handleGroupchatMessage(row, ws) {
	const handle = normalizeHandle(row.handle);
	const text = String(row.text || '').trim();
	if (!text) return;

	await appendChatMessage({
		message_guid: row.guid,
		chat_guid: row.chat_guid,
		workspace_id: ws.workspace_id,
		workspace_label: ws.label,
		handle,
		text,
		is_from_me: false,
		db_date: Number(row.date) || null
	});
	const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
	log(`◉ ${ws.label} ← ${shortHandle(handle)}: "${preview}"`);
}

// ── Poll loop ──────────────────────────────────────────────────────────────────

let polling = false;
const inflight = new Map(); // handle/chat_guid -> Promise; serializes turns

async function pollOnce() {
	const rows = fetchNewMessages(state.lastSeenRowId, groupchatGuids);
	if (!rows.length) return;

	for (const row of rows) {
		state.lastSeenRowId = Math.max(state.lastSeenRowId, Number(row.rowid) || 0);
		if (Number(row.is_from_me) === 1) continue;
		if (state.processed[row.guid]) continue;
		state.processed[row.guid] = Date.now();

		const handle = normalizeHandle(row.handle);
		const chatGuid = row.chat_guid || '';
		const ws = chatGuidIndex.get(chatGuid);

		if (ws) {
			// Mapped groupchat. Only store messages from the PM; ignore tenant/
			// owner replies for now (correlator design only triggers on PM).
			if (!ws.pm_handles.has(handle)) continue;
			const key = chatGuid;
			const prev = inflight.get(key) ?? Promise.resolve();
			const next = prev
				.then(() => handleGroupchatMessage(row, ws))
				.catch((err) => log(`groupchat handle error: ${err.message}`));
			inflight.set(key, next);
			next.finally(() => { if (inflight.get(key) === next) inflight.delete(key); });
			continue;
		}

		// Groupchat we don't recognize — drop. (Demo path is 1:1 only.)
		if (row.room_name) continue;
		// Demo path. Real customer/vendor numbers (knownSet) are dropped so
		// testing doesn't hijack real conversations.
		if (knownSet.has(handle)) continue;

		const prev = inflight.get(handle) ?? Promise.resolve();
		const next = prev.then(() => handleIncoming(row)).catch((err) => log(`handle error: ${err.message}`));
		inflight.set(handle, next);
		next.finally(() => { if (inflight.get(handle) === next) inflight.delete(handle); });
	}

	await saveState();
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
	// Build the work-orders chat-guid index from env (set above by loadDotEnv).
	// Used by the poll loop to route mapped groupchat rows to chat-log capture
	// instead of the demo subagent.
	chatGuidIndex = buildChatGuidIndex();
	groupchatGuids = [...chatGuidIndex.keys()];
	for (const [guid, w] of chatGuidIndex.entries()) {
		log(`listening on ${w.label}: ${guid} (pm: ${[...w.pm_handles].join(', ') || '(none)'})`);
	}

	await loadState();

	if (HELPER_ENABLED) {
		// Wait briefly for the helper to dial in (Messages.app may have just launched).
		for (let i = 0; i < 12 && !helper.isConnected(); i++) {
			await new Promise(r => setTimeout(r, 250));
		}
		const ping = await helper.ping();
		if (ping.ok) log(`helper online (Messages.app pid=${ping.pid})`);
		else log(`helper offline: ${ping.error} — running without typing/read`);
	} else {
		log('helper disabled via HELPER_DISABLED=1');
	}
	if (DEMO_HANDLE) log(`scoped to DEMO_HANDLE=${DEMO_HANDLE}`);

	// Drafts UI. Send button calls the dylib via helper.send.
	await startUi({
		port: Number(process.env.WORK_ORDERS_PORT ?? 7878),
		log,
		sendIMessage: async ({ chatGuid, body }) => {
			if (!HELPER_ENABLED) {
				return { ok: false, error: 'helper disabled (HELPER_DISABLED=1)' };
			}
			if (!chatGuid) {
				return { ok: false, error: 'draft has no chat guid' };
			}
			const r = await helper.send(chatGuid, body);
			if (!r.ok) {
				log(`work-order send failed: ${r.error}`);
				return { ok: false, error: r.error };
			}
			log(`work-order sent to ${chatGuid}: "${body.slice(0, 60)}${body.length > 60 ? '…' : ''}"`);
			return { ok: true, guid: r.guid ?? null };
		}
	});

	// F1: poll issues_v2 for new work orders and create groupchat drafts.
	await startIssuePoller();

	log(`agent server started (poll=${POLL_INTERVAL_MS}ms, lastRow=${state.lastSeenRowId})`);

	setInterval(async () => {
		if (polling) return;
		polling = true;
		try {
			await pollOnce();
		} catch (err) {
			log(`poll error: ${err.message}`);
		} finally {
			polling = false;
		}
	}, POLL_INTERVAL_MS);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
