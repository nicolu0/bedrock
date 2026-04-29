#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 1000;
const API_DELAY_MS = 3000;
const SELF_TEST_PREFIX = '!';
const FALLBACK_REPLY = 'hmmm';
const MAX_PROCESSED_GUIDS = 5000;
const OPENAI_MODEL = 'gpt-5.4-mini';
const MESSAGE_SEPARATOR = '%%%%';
const MAX_WORDS_PER_PART = 14;
const BETWEEN_MESSAGE_PARTS_MS = 3000;
const STREAM_ONLY = false;

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(SCRIPT_DIR, '.bridge-state.json');
const ENV_PATH = path.join(SCRIPT_DIR, '.env');
const APPLESCRIPT_DIR = path.join(SCRIPT_DIR, 'scripts');
const APPLESCRIPT_MARK_READ = path.join(APPLESCRIPT_DIR, 'mark_read.applescript');
const APPLESCRIPT_SEND = path.join(APPLESCRIPT_DIR, 'send.applescript');

const states = {
	IDLE: 'IDLE',
	MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
	READ_CONFIRMED: 'READ_CONFIRMED',
	TYPING: 'TYPING',
	RESPONDING: 'RESPONDING',
	DONE: 'DONE'
};

const state = {
	lastSeenRowId: 0,
	processed: {}
};

let polling = false;
let sending = false;
const outgoingQueue = [];
const deliveryTrackers = new Map();

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
	return new Date().toISOString();
}

async function loadDotEnv() {
	try {
		const raw = await fs.readFile(ENV_PATH, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const idx = trimmed.indexOf('=');
			if (idx <= 0) continue;
			const key = trimmed.slice(0, idx).trim();
			let value = trimmed.slice(idx + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (!(key in process.env)) process.env[key] = value;
		}
	} catch {
		// .env optional
	}
}

function log(event, data = {}) {
	const payload = { ts: nowIso(), event, ...data };
	console.log(JSON.stringify(payload));
}

function conciseLog(message) {
	console.log(message);
}

function normalizeHandle(raw) {
	if (!raw) return '';
	const value = String(raw).trim();
	if (!value) return '';
	if (value.includes('@')) return value.toLowerCase();

	const digitsOnly = value.replace(/[^\d+]/g, '');
	if (digitsOnly.startsWith('+')) {
		return `+${digitsOnly.slice(1).replace(/\D/g, '')}`;
	}

	const digits = digitsOnly.replace(/\D/g, '');
	if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
	if (digits.length === 10) return `+1${digits}`;
	if (digits.length > 0) return `+${digits}`;
	return value.toLowerCase();
}

function toUnixMs(appleDateNs) {
	if (!appleDateNs) return Date.now();
	const secondsSince2001 = Number(appleDateNs) / 1_000_000_000;
	const unixSeconds = secondsSince2001 + 978307200;
	return Math.round(unixSeconds * 1000);
}

async function loadState() {
	try {
		const raw = await fs.readFile(STATE_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		state.lastSeenRowId = Number(parsed.lastSeenRowId || 0);
		state.processed =
			parsed.processed && typeof parsed.processed === 'object' ? parsed.processed : {};
		conciseLog(`State loaded at row ${state.lastSeenRowId}`);
	} catch {
		state.lastSeenRowId = await fetchLatestRowId();
		state.processed = {};
		await saveState();
		conciseLog(`State initialized at row ${state.lastSeenRowId}`);
	}
}

async function saveState() {
	const entries = Object.entries(state.processed).sort((a, b) => b[1] - a[1]);
	const trimmed = Object.fromEntries(entries.slice(0, MAX_PROCESSED_GUIDS));
	state.processed = trimmed;

	await fs.writeFile(
		STATE_PATH,
		JSON.stringify(
			{
				lastSeenRowId: state.lastSeenRowId,
				processed: state.processed
			},
			null,
			2
		),
		'utf8'
	);
}

async function runAppleScriptFile(filePath, args, context) {
	try {
		const { stdout, stderr } = await execFileAsync('osascript', [filePath, ...args]);
		if (stdout?.trim()) conciseLog(`[${context}] ${stdout.trim()}`);
		if (stderr?.trim()) conciseLog(`[${context} stderr] ${stderr.trim()}`);
		return true;
	} catch (error) {
		const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
		const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : '';
		conciseLog(`[${context} error] ${error.message}`);
		if (stderr) conciseLog(`[${context} stderr] ${stderr}`);
		if (stdout) conciseLog(`[${context} stdout] ${stdout}`);
		return false;
	}
}

async function markAsRead(message) {
	const chatUrl = `imessage://${encodeURIComponent(message.scriptHandle)}`;
	return runAppleScriptFile(APPLESCRIPT_MARK_READ, [chatUrl], 'mark_as_read');
}

function getOrCreateTracker(guid) {
	let tracker = deliveryTrackers.get(guid);
	if (tracker) return tracker;
	tracker = {
		enqueued: 0,
		sent: 0,
		closed: false,
		promise: null,
		resolve: null,
		reject: null
	};
	tracker.promise = new Promise((resolve, reject) => {
		tracker.resolve = resolve;
		tracker.reject = reject;
	});
	deliveryTrackers.set(guid, tracker);
	return tracker;
}

function enqueueOutgoingPart(message, partText) {
	const text = String(partText || '').trim();
	if (!text) return;
	const tracker = getOrCreateTracker(message.guid);
	tracker.enqueued += 1;
	outgoingQueue.push({
		guid: message.guid,
		chatGuid: message.chatGuid || '',
		scriptHandle: message.scriptHandle,
		text
	});
	conciseLog(`Stream part queued: ${text}`);
	void processOutgoingQueue();
}

function closeOutgoingForGuid(guid) {
	const tracker = getOrCreateTracker(guid);
	tracker.closed = true;
	if (tracker.enqueued === tracker.sent) {
		tracker.resolve();
		deliveryTrackers.delete(guid);
	}
}

function failOutgoingForGuid(guid, error) {
	const tracker = deliveryTrackers.get(guid);
	if (!tracker) return;
	tracker.reject(error);
	deliveryTrackers.delete(guid);
}

async function processOutgoingQueue() {
	if (sending) return;
	sending = true;

	try {
		while (outgoingQueue.length > 0) {
			const item = outgoingQueue.shift();
			if (!item) continue;
			conciseLog(`Sender: sending now (remaining=${outgoingQueue.length})`);

			const sent = await runAppleScriptFile(
				APPLESCRIPT_SEND,
				[item.chatGuid || '', item.scriptHandle, item.text],
				'send_reply'
			);

			if (!sent) {
				failOutgoingForGuid(item.guid, new Error(`Failed sending part for ${item.guid}`));
				continue;
			}
			const tracker = deliveryTrackers.get(item.guid);
			if (tracker) {
				tracker.sent += 1;
				if (tracker.closed && tracker.sent === tracker.enqueued) {
					tracker.resolve();
					deliveryTrackers.delete(item.guid);
				}
			}

			conciseLog(`Message sent: ${item.text}`);
			conciseLog(`Sender: cooldown ${BETWEEN_MESSAGE_PARTS_MS}ms`);

			await sleep(BETWEEN_MESSAGE_PARTS_MS);
		}
	} finally {
		sending = false;
	}
}

async function sendReply(message) {
	const sourceText = String(message.text || '')
		.replace(/^\s*!\s*/, '')
		.trim();
	conciseLog(`Message received: ${sourceText}`);
	conciseLog('OpenAI API called');

	if (STREAM_ONLY) {
		await generateReplyPartsStreamOnly(sourceText);
		conciseLog('Streaming complete (no send)');
		return;
	}

	const parts = await generateReplyPartsAndEnqueue(message, sourceText);
	conciseLog(`All parts queued (${parts.length})`);
}

function extractResponseText(data) {
	if (typeof data?.output_text === 'string' && data.output_text.trim())
		return data.output_text.trim();
	const pieces = [];
	for (const item of data?.output ?? []) {
		for (const content of item?.content ?? []) {
			if (content?.type === 'output_text' && typeof content.text === 'string') {
				pieces.push(content.text);
			}
		}
	}
	return pieces.join(' ').trim();
}

function normalizeReplyParts(rawText) {
	const cleaned = String(rawText || '').trim();
	if (!cleaned) return [];
	const rawParts = cleaned
		.split(MESSAGE_SEPARATOR)
		.map((p) => p.trim())
		.filter(Boolean);

	const parts = [];
	for (const part of rawParts) {
		const words = part.split(/\s+/).filter(Boolean);
		if (!words.length) continue;
		if (words.length <= MAX_WORDS_PER_PART) {
			parts.push(words.join(' '));
			continue;
		}

		for (let i = 0; i < words.length; i += MAX_WORDS_PER_PART) {
			parts.push(words.slice(i, i + MAX_WORDS_PER_PART).join(' '));
		}
	}

	if (!parts.length) return [];
	return parts.slice(0, 4);
}

async function generateReplyPartsAndEnqueue(message, userMessage) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		conciseLog(`OpenAI key missing at ${ENV_PATH}`);
		enqueueOutgoingPart(message, FALLBACK_REPLY);
		closeOutgoingForGuid(message.guid);
		return [FALLBACK_REPLY];
	}

	const systemPrompt = [
		'Write concise iMessage replies.',
		`Return output split by exactly ${MESSAGE_SEPARATOR}.`,
		`Do not use ${'%%%'} or any other separator.`,
		`Every split must be the exact token ${MESSAGE_SEPARATOR}.`,
		`Each message part should be a full thought and no more than ${MAX_WORDS_PER_PART} words.`,
		'Return plain text only; no extra commentary.'
	].join(' ');

	try {
		const response = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: OPENAI_MODEL,
				stream: true,
				input: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userMessage || 'No message content.' }
				]
			})
		});

		if (!response.ok) {
			const err = await response.text();
			throw new Error(`OpenAI ${response.status}: ${err}`);
		}

		return await streamAndEnqueueParts(response, message);
	} catch (error) {
		conciseLog(`OpenAI error: ${error.message}`);
		enqueueOutgoingPart(message, FALLBACK_REPLY);
		closeOutgoingForGuid(message.guid);
		return [FALLBACK_REPLY];
	}
}

async function generateReplyPartsStreamOnly(userMessage) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		conciseLog(`OpenAI key missing at ${ENV_PATH}`);
		return [FALLBACK_REPLY];
	}

	const systemPrompt = [
		'Write concise iMessage replies.',
		`Return output split by exactly ${MESSAGE_SEPARATOR}.`,
		`Do not use ${'%%%'} or any other separator.`,
		`Every split must be the exact token ${MESSAGE_SEPARATOR}.`,
		`Each message part should be a full thought and no more than ${MAX_WORDS_PER_PART} words.`,
		'Return plain text only; no extra commentary.'
	].join(' ');

	try {
		const response = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: OPENAI_MODEL,
				stream: true,
				input: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userMessage || 'No message content.' }
				]
			})
		});

		if (!response.ok) {
			const err = await response.text();
			throw new Error(`OpenAI ${response.status}: ${err}`);
		}

		return await readStreamingParts(response);
	} catch (error) {
		conciseLog(`OpenAI error: ${error.message}`);
		return [FALLBACK_REPLY];
	}
}

async function readStreamingParts(response) {
	if (!response.body) return [FALLBACK_REPLY];
	const decoder = new TextDecoder();
	let buffer = '';
	let pending = '';
	const parts = [];

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
				if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
					pending += event.delta;
					conciseLog(`Chunk: ${event.delta.replace(/\n/g, '\\n')}`);
					while (pending.includes(MESSAGE_SEPARATOR)) {
						const idx = pending.indexOf(MESSAGE_SEPARATOR);
						const partRaw = pending.slice(0, idx);
						pending = pending.slice(idx + MESSAGE_SEPARATOR.length);
						const normalized = normalizeReplyParts(partRaw);
						for (const part of normalized) {
							parts.push(part);
							conciseLog(`Queueing message: ${part}`);
						}
					}
				}
			} catch {
				// ignore non-json lines
			}
		}
	}

	const tail = normalizeReplyParts(pending);
	for (const part of tail) {
		parts.push(part);
		conciseLog(`Queueing message: ${part}`);
	}

	if (!parts.length) {
		parts.push(FALLBACK_REPLY);
		conciseLog(`Stream part queued: ${FALLBACK_REPLY}`);
	}

	return parts;
}

async function streamAndEnqueueParts(response, message) {
	if (!response.body) {
		enqueueOutgoingPart(message, FALLBACK_REPLY);
		closeOutgoingForGuid(message.guid);
		return [FALLBACK_REPLY];
	}
	const decoder = new TextDecoder();
	let buffer = '';
	let combined = '';
	let pending = '';
	const emittedParts = [];

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
				if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
					combined += event.delta;
					pending += event.delta;
					while (pending.includes(MESSAGE_SEPARATOR)) {
						const idx = pending.indexOf(MESSAGE_SEPARATOR);
						const partRaw = pending.slice(0, idx);
						pending = pending.slice(idx + MESSAGE_SEPARATOR.length);
						const normalized = normalizeReplyParts(partRaw);
						for (const part of normalized) {
							emittedParts.push(part);
							enqueueOutgoingPart(message, part);
						}
					}
				}
				if (event.type === 'response.completed') {
					const fallback = extractResponseText(event.response);
					if (!combined && fallback) {
						combined = fallback;
						pending += fallback;
					}
				}
			} catch {
				// ignore non-json stream lines
			}
		}
	}
	const tailParts = normalizeReplyParts(pending);
	for (const part of tailParts) {
		emittedParts.push(part);
		enqueueOutgoingPart(message, part);
	}
	if (!emittedParts.length) {
		emittedParts.push(FALLBACK_REPLY);
		enqueueOutgoingPart(message, FALLBACK_REPLY);
	}
	closeOutgoingForGuid(message.guid);
	return emittedParts;
}

async function fetchCandidateMessages(afterRowId) {
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
  AND ltrim(COALESCE(m.text, '')) LIKE '!%'
ORDER BY m.ROWID ASC
LIMIT 100;`;

	const { stdout } = await execFileAsync('sqlite3', ['-json', CHAT_DB_PATH, sql]);
	const output = stdout.trim();
	if (!output) return [];
	return JSON.parse(output);
}

async function fetchLatestRowId() {
	const { stdout } = await execFileAsync('sqlite3', [
		'-json',
		CHAT_DB_PATH,
		'SELECT COALESCE(MAX(ROWID), 0) AS max_rowid FROM message;'
	]);
	const output = stdout.trim();
	if (!output) return 0;
	const parsed = JSON.parse(output);
	return Number(parsed?.[0]?.max_rowid || 0);
}

function isOneToOneIMessage(message) {
	if (message.service !== 'iMessage') return false;
	if (Number(message.has_attachments) !== 0) return false;
	if (Number(message.chat_style) !== 45) return false;
	if (message.room_name !== null && message.room_name !== '') return false;
	if (!message.handle) return false;
	return true;
}

function shouldProcess(message) {
	if (!isOneToOneIMessage(message)) {
		return { ok: false, reason: 'scope_filter' };
	}

	if (state.processed[message.guid]) {
		return { ok: false, reason: 'already_processed' };
	}

	const normalizedHandle = normalizeHandle(message.handle);
	const text = String(message.text || '');
	if (!text.trimStart().startsWith(SELF_TEST_PREFIX)) {
		return { ok: false, reason: 'missing_bang_prefix' };
	}

	return { ok: true, normalizedHandle, fromMe: Number(message.is_from_me) === 1 };
}

async function runStateMachine(message) {
	let current = states.MESSAGE_RECEIVED;
	conciseLog('Read attempt started');
	const readOk = await markAsRead(message);
	conciseLog(`Read attempted: ${readOk ? 'ok' : 'failed'}`);
	current = states.READ_CONFIRMED;

	if (!STREAM_ONLY) await sleep(API_DELAY_MS);

	current = states.RESPONDING;
	await sendReply(message);

	current = states.DONE;

	state.processed[message.guid] = Date.now();
	await saveState();

	conciseLog('Message processed');
}

async function pollOnce() {
	const rows = await fetchCandidateMessages(state.lastSeenRowId);
	if (!rows.length) return;

	for (const row of rows) {
		state.lastSeenRowId = Math.max(state.lastSeenRowId, Number(row.rowid) || 0);
		const decision = shouldProcess(row);

		if (!decision.ok) continue;

		const prepared = {
			...row,
			handle: decision.normalizedHandle,
			chatGuid: row.chat_guid || '',
			scriptHandle: row.handle || decision.normalizedHandle,
			receivedAtUnixMs: toUnixMs(row.date)
		};

		await runStateMachine(prepared);
	}

	await saveState();
}

async function start() {
	await loadDotEnv();
	await loadState();
	conciseLog(
		`Bridge started (poll=${POLL_INTERVAL_MS}ms, apiDelay=${API_DELAY_MS}ms, sendGap=${BETWEEN_MESSAGE_PARTS_MS}ms, streamOnly=${STREAM_ONLY})`
	);

	setInterval(async () => {
		if (polling) return;
		polling = true;
		try {
			await pollOnce();
		} catch (error) {
			conciseLog(`Poll error: ${error.message}`);
		} finally {
			polling = false;
		}
	}, POLL_INTERVAL_MS);
}

start().catch((error) => {
	conciseLog(`Fatal: ${error.message}`);
	process.exit(1);
});
