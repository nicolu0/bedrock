// Data access layer for work-orders state.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILES = {
	drafts: path.join(__dirname, 'drafts.json'),
	sent: path.join(__dirname, 'sent-log.json'),
	response: path.join(__dirname, 'response-log.json'),
	issuesCursor: path.join(__dirname, 'issues-cursor.json'),
	chatCursor: path.join(__dirname, 'chat-cursor.json')
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
