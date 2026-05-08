#!/usr/bin/env node
// Texting-UX demo. The point of this script (vs demo.mjs) is to showcase
// real iMessage typing dots and read receipts driven by the MessagesHelper
// bundle injected into Messages.app. Reading still happens via chat.db; the
// helper is only used for the two UX signals + (eventually) sending.
//
// Reply logic here is intentionally a stub — replace with real LLM behavior
// when you want. The whole point is to see the four hook points line up.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { helper } from './imessage-helper.mjs';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 1000;
const REPLY_THINK_MS = 2500;          // how long to "think" before replying (dots stay on)
const BETWEEN_PARTS_MS = 1800;        // gap between message parts (dots toggle off->on)
const HELPER_ENABLED = process.env.HELPER_DISABLED !== '1';
const DEMO_HANDLE = process.env.DEMO_HANDLE ? normalizeHandle(process.env.DEMO_HANDLE) : null;

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(SCRIPT_DIR, '.textingux-state.json');
const APPLESCRIPT_SEND = path.join(SCRIPT_DIR, 'scripts', 'send.applescript');

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

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
	console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function shortHandle(handle) {
	return handle.replace(/^\+1/, '').replace(/[^\d@.]/g, '') || handle;
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
// streamtyped binary) instead of the text column. Lift the plain UTF-8 string
// from the streamtyped record. Pattern: 0x2B + length + utf8 bytes.
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
				if (!candidate.includes('\x00') && !/^NS[A-Z]/.test(candidate)) {
					return candidate;
				}
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

// ── Send (still AppleScript for now) ───────────────────────────────────────────

async function sendPart(chatGuid, handle, text) {
	try {
		await execFileAsync('osascript', [APPLESCRIPT_SEND, chatGuid || '', handle, text]);
		return true;
	} catch (err) {
		log(`applescript error: ${err.message}`);
		return false;
	}
}

// ── Reply logic (STUB — replace this with your LLM call) ───────────────────────

async function generateReplyParts(_incomingText) {
	// Stub: return 2-3 short canned parts. Replace with OpenAI / your LLM.
	return [
		'got it',
		'one sec while i look that up',
		'what property is this for?',
	];
}

// ── Main flow per incoming message ─────────────────────────────────────────────

async function handleIncoming(row) {
	const handle = normalizeHandle(row.handle);
	const chatGuid = row.chat_guid || '';
	const text = String(row.text || '').trim();
	if (!text) return;
	if (DEMO_HANDLE && handle !== DEMO_HANDLE) return;

	log(`← ${shortHandle(handle)}: "${text}"`);

	// Hook 1: read receipt — fire the moment we've consumed the message.
	await markRead(chatGuid);

	// Hook 2: typing dots on while we "think".
	await setTyping(chatGuid, true);

	try {
		await sleep(REPLY_THINK_MS);
		const parts = await generateReplyParts(text);

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			// Hook 3: dots off briefly so each new bubble feels distinct, then back on.
			if (i > 0) {
				await setTyping(chatGuid, false);
				await sleep(BETWEEN_PARTS_MS);
				await setTyping(chatGuid, true);
				// short "composing this part" pause
				await sleep(700);
			}
			const ok = await sendPart(chatGuid, handle, part);
			if (ok) log(`→ ${shortHandle(handle)}: "${part}"`);
		}
	} finally {
		// Hook 4: never strand the dots on.
		await setTyping(chatGuid, false);
	}
}

// ── Poll loop ──────────────────────────────────────────────────────────────────

let polling = false;

async function pollOnce() {
	const rows = fetchNewMessages(state.lastSeenRowId);
	if (!rows.length) return;

	for (const row of rows) {
		state.lastSeenRowId = Math.max(state.lastSeenRowId, Number(row.rowid) || 0);

		if (Number(row.is_from_me) === 1) continue;
		if (row.room_name) continue;
		if (state.processed[row.guid]) continue;
		state.processed[row.guid] = Date.now();

		// Fire and forget per chat — different conversations run in parallel.
		// Within a chat, the awaited chain in handleIncoming serializes naturally.
		handleIncoming(row).catch(err => log(`handle error: ${err.message}`));
	}

	await saveState();
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
	await loadState();

	if (HELPER_ENABLED) {
		const ping = await helper.ping();
		if (ping.ok) {
			log(`helper online (Messages.app pid=${ping.pid})`);
		} else {
			log(`helper offline: ${ping.error} — running without typing/read`);
		}
	} else {
		log('helper disabled via HELPER_DISABLED=1');
	}
	if (DEMO_HANDLE) log(`scoped to DEMO_HANDLE=${DEMO_HANDLE}`);

	log(`textingux started (poll=${POLL_INTERVAL_MS}ms, lastRow=${state.lastSeenRowId})`);

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
