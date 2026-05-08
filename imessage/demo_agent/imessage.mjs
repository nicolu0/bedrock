#!/usr/bin/env node
// iMessage entrypoint for demo_agent.
//
// Polls chat.db for incoming messages from unknown numbers, hands each one to
// the orchestrator, and maps the orchestrator's event stream to real iMessage
// signals via the injected MessagesHelper bundle:
//   read        -> markRead(chatGuid)        (Read receipt on the sender's phone)
//   typing      -> setTyping(chatGuid, true) (the "..." dots)
//   message     -> setTyping(false) + send via AppleScript
//   tool_call   -> just log
//
// Setup prerequisites are documented in imessage/native/README.md. Run:
//   imessage/native/run-messages.sh        # in one terminal
//   node imessage/demo_agent/imessage.mjs  # in another

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { helper } from '../imessage-helper.mjs';
import { runTurn } from './core/orchestrator.mjs';

const execFileAsync = promisify(execFile);

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
const REPO_IMESSAGE_DIR = path.join(SCRIPT_DIR, '..');
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const STATE_PATH = path.join(SCRIPT_DIR, '.imessage-state.json');
const APPLESCRIPT_SEND = path.join(REPO_IMESSAGE_DIR, 'scripts', 'send.applescript');

// ── Routing: ignore numbers we know (so testing in a real-world chat doesn't
// hijack actual conversations). Reuses demo_v0-config.mjs since the demo_agent
// is built on top of that demo's identity model.
let knownSet = new Set();
try {
	const { KNOWN_NUMBERS } = await import('../demo_v0-config.mjs');
	knownSet = new Set((KNOWN_NUMBERS ?? []).map(normalizeHandle));
} catch {
	// no config — accept all
}

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

await loadDotEnv(path.join(SCRIPT_DIR, '..', '..', '.env'));
await loadDotEnv(path.join(SCRIPT_DIR, '..', '.env'));
await loadDotEnv(path.join(SCRIPT_DIR, '.env'));

if (!process.env.OPENAI_API_KEY) {
	console.log('OPENAI_API_KEY not set — checked .env in repo root, imessage/, and demo_agent/');
	process.exit(1);
}

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

function fetchNewMessages(afterRowId) {
	try {
		const rows = getDb().prepare(`
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
			  AND c.style = 45
			  AND c.room_name IS NULL
			ORDER BY m.ROWID ASC
			LIMIT 100
		`).all(Number(afterRowId) || 0);
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

async function sendPart(chatGuid, handle, text) {
	try {
		await execFileAsync('osascript', [APPLESCRIPT_SEND, chatGuid || '', handle, text]);
		return true;
	} catch (err) {
		log(`applescript error: ${err.message}`);
		return false;
	}
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
		await runTurn(handle, text, { onEvent, ctx: { chatGuid, react } });
	} catch (err) {
		log(`turn error: ${err.message}`);
	} finally {
		// Defensive: kill dots in case anything left them on (e.g., we threw
		// during the dwell sleep before the typing-off call).
		await setTyping(chatGuid, false);
	}
}

// ── Poll loop ──────────────────────────────────────────────────────────────────

let polling = false;
const inflight = new Map(); // handle -> Promise; serializes turns per chat

async function pollOnce() {
	const rows = fetchNewMessages(state.lastSeenRowId);
	if (!rows.length) return;

	for (const row of rows) {
		state.lastSeenRowId = Math.max(state.lastSeenRowId, Number(row.rowid) || 0);
		if (Number(row.is_from_me) === 1) continue;
		if (row.room_name) continue;
		if (state.processed[row.guid]) continue;
		state.processed[row.guid] = Date.now();

		const handle = normalizeHandle(row.handle);
		// Serialize per-handle so a fast follow-up doesn't race the in-flight turn,
		// but different chats stay parallel (no global focus state to fight over).
		const prev = inflight.get(handle) ?? Promise.resolve();
		const next = prev.then(() => handleIncoming(row)).catch((err) => log(`handle error: ${err.message}`));
		inflight.set(handle, next);
		next.finally(() => { if (inflight.get(handle) === next) inflight.delete(handle); });
	}

	await saveState();
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
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

	log(`demo_agent imessage started (poll=${POLL_INTERVAL_MS}ms, lastRow=${state.lastSeenRowId})`);

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
