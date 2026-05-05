#!/usr/bin/env node
// Bedrock Demo Agent
// Watches chat.db for messages from unknown numbers (not in KNOWN_NUMBERS)
// and keeps them engaged in friendly conversation via iMessage.
// Serves a local web UI on DEMO_PORT (default 3458) for live monitoring.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { KNOWN_NUMBERS } from './demo-config.mjs';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 1000;
const BETWEEN_PARTS_MS = 2500;
const OPENAI_MODEL = 'gpt-4.1-mini';
const MESSAGE_SEPARATOR = '%%%%';
const FALLBACK_REPLY = 'hey!';
const MAX_HISTORY = 40; // messages to keep per conversation for context

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(SCRIPT_DIR, '.demo-state.json');
const ENV_PATH = path.join(SCRIPT_DIR, '..', '.env');
const LOCAL_ENV_PATH = path.join(SCRIPT_DIR, '.env');
const APPLESCRIPT_SEND = path.join(SCRIPT_DIR, 'scripts', 'send.applescript');

const DEMO_PORT = parseInt(process.env.DEMO_PORT ?? '3458', 10);

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
	lastSeenRowId: 0,
	processed: {},   // guid -> unix ms, dedup
};

// In-memory conversation history per normalized handle
// handle -> [{ role: 'user'|'assistant', content: string, ts: ISO }]
const conversations = new Map();

let polling = false;
let sending = false;
const outgoingQueue = [];

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function log(msg, extra = {}) {
	console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
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

function toUnixMs(appleDateNs) {
	if (!appleDateNs) return Date.now();
	const secondsSince2001 = Number(appleDateNs) / 1_000_000_000;
	return Math.round((secondsSince2001 + 978307200) * 1000);
}

// ── Env ────────────────────────────────────────────────────────────────────────

async function loadDotEnv(envPath) {
	try {
		const raw = await fs.readFile(envPath, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const idx = trimmed.indexOf('=');
			if (idx <= 0) continue;
			const key = trimmed.slice(0, idx).trim();
			let value = trimmed.slice(idx + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!(key in process.env)) process.env[key] = value;
		}
	} catch { /* optional */ }
}

// ── Persistence ────────────────────────────────────────────────────────────────

async function loadState() {
	try {
		const raw = await fs.readFile(STATE_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		state.lastSeenRowId = Number(parsed.lastSeenRowId ?? 0);
		state.processed = parsed.processed ?? {};
		log('state loaded', { lastSeenRowId: state.lastSeenRowId });
	} catch {
		state.lastSeenRowId = await fetchLatestRowId();
		state.processed = {};
		await saveState();
		log('state initialized', { lastSeenRowId: state.lastSeenRowId });
	}
}

async function saveState() {
	const entries = Object.entries(state.processed).sort((a, b) => b[1] - a[1]);
	state.processed = Object.fromEntries(entries.slice(0, 2000));
	await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── Routing ────────────────────────────────────────────────────────────────────

const knownSet = new Set(KNOWN_NUMBERS.map(normalizeHandle));

function isKnown(handle) {
	return knownSet.has(normalizeHandle(handle));
}

// ── chat.db ────────────────────────────────────────────────────────────────────

async function fetchLatestRowId() {
	try {
		const { stdout } = await execFileAsync('sqlite3', ['-json', CHAT_DB_PATH,
			'SELECT COALESCE(MAX(ROWID),0) AS max_rowid FROM message;']);
		const parsed = JSON.parse(stdout.trim() || '[]');
		return Number(parsed[0]?.max_rowid ?? 0);
	} catch (err) {
		log('fetchLatestRowId error', { err: err.message });
		return 0;
	}
}

async function fetchNewMessages(afterRowId) {
	const sql = `
SELECT
  m.ROWID AS rowid,
  m.guid,
  m.text,
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
WHERE m.ROWID > ${Number(afterRowId) || 0}
  AND m.service = 'iMessage'
  AND COALESCE(m.cache_has_attachments, 0) = 0
  AND c.style = 45
  AND c.room_name IS NULL
ORDER BY m.ROWID ASC
LIMIT 100;`;

	try {
		const { stdout } = await execFileAsync('sqlite3', ['-json', CHAT_DB_PATH, sql]);
		return JSON.parse(stdout.trim() || '[]');
	} catch (err) {
		log('fetchNewMessages error', { err: err.message });
		return [];
	}
}

// ── AppleScript sender ─────────────────────────────────────────────────────────

async function sendPartViaAppleScript(chatGuid, handle, text) {
	try {
		const { stdout, stderr } = await execFileAsync('osascript', [
			APPLESCRIPT_SEND, chatGuid || '', handle, text,
		]);
		if (stdout?.trim()) log('applescript stdout', { stdout: stdout.trim() });
		if (stderr?.trim()) log('applescript stderr', { stderr: stderr.trim() });
		return true;
	} catch (err) {
		log('applescript error', { err: err.message });
		return false;
	}
}

// ── Outgoing queue ─────────────────────────────────────────────────────────────

async function processOutgoingQueue() {
	if (sending) return;
	sending = true;
	try {
		while (outgoingQueue.length > 0) {
			const item = outgoingQueue.shift();
			if (!item) continue;
			const ok = await sendPartViaAppleScript(item.chatGuid, item.handle, item.text);
			if (ok) {
				log('sent', { handle: item.handle, text: item.text });
				const conv = conversations.get(item.handle) ?? [];
				conv.push({ role: 'assistant', content: item.text, ts: new Date().toISOString() });
				if (conv.length > MAX_HISTORY) conv.splice(0, conv.length - MAX_HISTORY);
				conversations.set(item.handle, conv);
			}
			await sleep(BETWEEN_PARTS_MS);
		}
	} finally {
		sending = false;
	}
}

function enqueue(handle, chatGuid, text) {
	const trimmed = text.trim();
	if (!trimmed) return;
	outgoingQueue.push({ handle, chatGuid, text: trimmed });
	void processOutgoingQueue();
}

// ── OpenAI ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
	'You are Bedrock, an AI assistant for property managers.\n\n' +
	'Your job is to guide the user through a short demo of how Bedrock works.\n' +
	'Follow this flow exactly, in order:\n\n' +
	'1. Ask for one of their properties.\n' +
	'2. Ask for their go-to plumber or handyman.\n' +
	'3. Surface a fake work order using their answers:\n' +
	'   "Just got a new one in — clogged toilet in unit 2 at [property]. Should I send [vendor]?"\n' +
	'4. When they say yes (or anything affirmative):\n' +
	'   "Done — I\'ve logged it in your PMS and notified the tenant and [vendor]."\n' +
	'   Then immediately follow with:\n' +
	'   "I\'ll keep an eye on this one and follow up with the tenant to confirm the work gets done. Want to run through another one?"\n\n' +
	'Rules:\n' +
	'- If the user asks a question at any point, answer it briefly and warmly, then bring them back to the flow.\n' +
	'- Keep messages short. One or two sentences max.\n' +
	'- Be friendly and casual, not corporate.\n' +
	'- Do not skip steps or jump ahead.\n' +
	'- Do not break character or explain that this is a demo.\n\n' +
	`Split your reply into 1-2 short iMessages using ${MESSAGE_SEPARATOR} between each one. ` +
	`Only place ${MESSAGE_SEPARATOR} after a sentence ends (after . ! ?). Never place ${MESSAGE_SEPARATOR} mid-sentence. ` +
	'Each message is one short sentence, like a real text — keep them brief. ' +
	'Write in all lowercase. No capitalization, even at the start of sentences. ' +
	'Plain text only. No markdown. No bullet points. No emoji unless they used one first.';

async function callOpenAI(handle, chatGuid) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		log('OPENAI_API_KEY not set');
		enqueue(handle, chatGuid, FALLBACK_REPLY);
		return;
	}

	const history = conversations.get(handle) ?? [];
	const messages = [
		{ role: 'system', content: SYSTEM_PROMPT },
		...history.map(({ role, content }) => ({ role, content })),
	];

	const response = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ model: OPENAI_MODEL, messages, max_tokens: 200, stream: true }),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`OpenAI ${response.status}: ${err}`);
	}

	if (!response.body) {
		enqueue(handle, chatGuid, FALLBACK_REPLY);
		return;
	}

	const decoder = new TextDecoder();
	let buffer = '';
	let pending = '';
	let fullRaw = '';
	let emitted = 0;

	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const rawLine of lines) {
			const line = rawLine.trim();
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (!payload || payload === '[DONE]') continue;
			try {
				const event = JSON.parse(payload);
				const delta = event.choices?.[0]?.delta?.content;
				if (typeof delta === 'string') {
					fullRaw += delta;
					pending += delta;
					while (pending.includes(MESSAGE_SEPARATOR) && emitted < 4) {
						const idx = pending.indexOf(MESSAGE_SEPARATOR);
						const partRaw = pending.slice(0, idx);
						pending = pending.slice(idx + MESSAGE_SEPARATOR.length);
						for (const p of splitIntoParts(partRaw)) {
							enqueue(handle, chatGuid, p);
							emitted++;
						}
					}
				}
			} catch { /* ignore non-json lines */ }
		}
	}

	// flush whatever's left after the stream ends
	if (emitted < 4) {
		for (const p of splitIntoParts(pending)) {
			enqueue(handle, chatGuid, p);
			emitted++;
			if (emitted >= 4) break;
		}
	}

	if (emitted === 0) enqueue(handle, chatGuid, FALLBACK_REPLY);
	log('openai raw response', { handle, raw: fullRaw });
}

function splitIntoParts(raw) {
	if (!raw?.trim()) return [];
	return raw.split(MESSAGE_SEPARATOR).map((p) => p.trim()).filter(Boolean).slice(0, 4);
}

// ── Poll loop ──────────────────────────────────────────────────────────────────

async function pollOnce() {
	const rows = await fetchNewMessages(state.lastSeenRowId);
	if (!rows.length) return;

	for (const row of rows) {
		state.lastSeenRowId = Math.max(state.lastSeenRowId, Number(row.rowid) ?? 0);

		// Skip outgoing messages
		if (Number(row.is_from_me) === 1) continue;

		// Skip group chats (already filtered in SQL but belt-and-suspenders)
		if (row.room_name) continue;

		const handle = normalizeHandle(row.handle);
		if (!handle) continue;

		// Routing: known number → ignore
		if (isKnown(handle)) {
			log('known number, ignoring', { handle });
			continue;
		}

		// Dedup
		if (state.processed[row.guid]) continue;
		state.processed[row.guid] = Date.now();

		const text = String(row.text || '').trim();
		if (!text) continue;

		log('inbound from unknown', { handle, text });

		// Append to conversation history
		const conv = conversations.get(handle) ?? [];
		conv.push({ role: 'user', content: text, ts: new Date().toISOString() });
		if (conv.length > MAX_HISTORY) conv.splice(0, conv.length - MAX_HISTORY);
		conversations.set(handle, conv);

		// Generate and send reply
		try {
			await callOpenAI(handle, row.chat_guid ?? '');
			log('agent reply enqueued', { handle });
		} catch (err) {
			log('agent error', { handle, err: err.message });
			enqueue(handle, row.chat_guid ?? '', FALLBACK_REPLY);
		}
	}

	await saveState();
}

// ── Web UI ─────────────────────────────────────────────────────────────────────

function buildHtml() {
	const convEntries = [...conversations.entries()].sort((a, b) =>
		(b[1].at(-1)?.ts ?? '') > (a[1].at(-1)?.ts ?? '') ? 1 : -1
	);

	const threads = convEntries.map(([handle, msgs]) => {
		const bubbles = msgs.map((m) => {
			const side = m.role === 'assistant' ? 'right' : 'left';
			const bg = m.role === 'assistant' ? '#0b93f6' : '#e5e5ea';
			const color = m.role === 'assistant' ? '#fff' : '#000';
			return `
				<div style="display:flex;justify-content:${side === 'right' ? 'flex-end' : 'flex-start'};margin:4px 0">
					<div style="max-width:70%;padding:8px 12px;border-radius:16px;background:${bg};color:${color};font-size:14px;word-break:break-word">
						${escHtml(m.content)}
						<div style="font-size:10px;opacity:0.6;margin-top:2px;text-align:right">${m.ts?.slice(11, 19) ?? ''}</div>
					</div>
				</div>`;
		}).join('');

		return `
			<div style="margin-bottom:32px">
				<h3 style="font-family:monospace;font-size:14px;color:#666;margin:0 0 8px">${escHtml(handle)}</h3>
				<div style="background:#f9f9f9;border-radius:12px;padding:12px;border:1px solid #e0e0e0">
					${bubbles || '<p style="color:#aaa;font-size:13px">no messages yet</p>'}
				</div>
			</div>`;
	}).join('') || '<p style="color:#aaa">No conversations yet. Waiting for unknown numbers to text in.</p>';

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Bedrock Demo — Live View</title>
<meta http-equiv="refresh" content="3">
<style>
  body { font-family: -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; background: #fff; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 32px; }
</style>
</head>
<body>
<h1>Bedrock Demo</h1>
<p class="subtitle">Auto-refreshes every 3 seconds &nbsp;·&nbsp; ${convEntries.length} conversation${convEntries.length !== 1 ? 's' : ''} &nbsp;·&nbsp; last rowid ${state.lastSeenRowId}</p>
${threads}
</body>
</html>`;
}

function escHtml(str) {
	return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function startWebUI(port) {
	const server = createServer((_req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(buildHtml());
	});
	server.listen(port, '127.0.0.1', () => {
		log('web UI started', { url: `http://localhost:${port}` });
	});
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
	await loadDotEnv(ENV_PATH);
	await loadDotEnv(LOCAL_ENV_PATH);
	await loadState();

	startWebUI(DEMO_PORT);

	log('demo agent started', {
		poll: `${POLL_INTERVAL_MS}ms`,
		model: OPENAI_MODEL,
		knownNumbers: KNOWN_NUMBERS.length,
		ui: `http://localhost:${DEMO_PORT}`,
	});

	setInterval(async () => {
		if (polling) return;
		polling = true;
		try {
			await pollOnce();
		} catch (err) {
			log('poll error', { err: err.message });
		} finally {
			polling = false;
		}
	}, POLL_INTERVAL_MS);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
