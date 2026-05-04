#!/usr/bin/env node
// Polling daemon: watches chat.db for new Property Manager messages and extracts
// behavioral notes into owner_notes. Incremental counterpart to analyze-chat.mjs.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 30_000;
const CONTEXT_WINDOW = 30; // messages before new ones to include for context
const OPENAI_MODEL = 'gpt-4.1';
const MAX_TOKENS = 2000;
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const DEFAULT_ROOM_NAME = '800f91610cea448fb5085603ab3ea973';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_ENV_PATH = path.join(SCRIPT_DIR, '..', '.env');
const LOCAL_ENV_PATH = path.join(SCRIPT_DIR, '.env');

const SENDER_LABELS = {
	'+13106990643': 'Property Manager',
	'+19496566275': 'AI Agent (949)',
	'+16504443716': 'AI Agent (650)',
	me: 'AI Agent (me)',
};

// ── CLI / env config ──────────────────────────────────────────────────────────

const roomFlag = process.argv.find(a => a.startsWith('--room='));
const pmFlag = process.argv.find(a => a.startsWith('--pm='));

// --room accepts either a room_name (group chat) or a guid (1-on-1 or group chat)
const ROOM_ID = roomFlag
	? roomFlag.split('=')[1]
	: (process.env.IMESSAGE_READ_ROOM_NAME ?? DEFAULT_ROOM_NAME);

// --pm overrides which phone number is treated as "Property Manager" (for testing)
if (pmFlag) SENDER_LABELS[pmFlag.split('=')[1]] = 'Property Manager';

// State file is keyed by room so test runs don't clobber prod state
const stateSlug = ROOM_ID.replace(/[^a-z0-9]/gi, '-').slice(0, 40);
const STATE_PATH = path.join(SCRIPT_DIR, `.imessage-read-state-${stateSlug}.json`);

// ── State ─────────────────────────────────────────────────────────────────────

const state = { lastRowId: 0 };

async function loadState() {
	try {
		const raw = await fs.readFile(STATE_PATH, 'utf8');
		state.lastRowId = JSON.parse(raw).lastRowId ?? 0;
		log(`state loaded, watching from rowid ${state.lastRowId}`);
	} catch {
		// First run — initialize to current max so we don't reprocess history
		const maxRowId = await queryMaxRowId();
		state.lastRowId = maxRowId;
		await saveState();
		log(`state initialized, watching from rowid ${state.lastRowId}`);
	}
}

async function saveState() {
	await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg, extra = {}) {
	console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}

// ── Env ───────────────────────────────────────────────────────────────────────

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
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) value = value.slice(1, -1);
			if (!(key in process.env)) process.env[key] = value;
		}
	} catch { /* optional */ }
}

// ── Apple timestamp ───────────────────────────────────────────────────────────

const APPLE_EPOCH_OFFSET = 978307200;

function appleTimestampToDate(ts) {
	if (!ts) return '';
	const seconds = ts > 1e10 ? ts / 1e9 : ts;
	return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000).toISOString();
}

// ── chat.db queries ───────────────────────────────────────────────────────────

async function queryMaxRowId() {
	const sql = `
SELECT COALESCE(MAX(m.ROWID), 0) AS max_rowid
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
WHERE (c.room_name = '${ROOM_ID}' OR c.guid = '${ROOM_ID}');`;
	const { stdout } = await execFileAsync('sqlite3', ['-json', CHAT_DB_PATH, sql]);
	const rows = JSON.parse(stdout.trim() || '[]');
	return rows[0]?.max_rowid ?? 0;
}

async function queryNewMessages(afterRowId) {
	const sql = `
SELECT m.ROWID AS rowid, m.date AS apple_ts, m.is_from_me, h.id AS handle, m.text
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
WHERE (c.room_name = '${ROOM_ID}' OR c.guid = '${ROOM_ID}')
  AND m.ROWID > ${afterRowId}
  AND m.text IS NOT NULL
  AND trim(m.text) != ''
ORDER BY m.ROWID ASC;`;
	const { stdout } = await execFileAsync('sqlite3', ['-json', CHAT_DB_PATH, sql]);
	return JSON.parse(stdout.trim() || '[]');
}

async function queryContextMessages(beforeRowId, limit) {
	const sql = `
SELECT m.ROWID AS rowid, m.date AS apple_ts, m.is_from_me, h.id AS handle, m.text
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
WHERE (c.room_name = '${ROOM_ID}' OR c.guid = '${ROOM_ID}')
  AND m.ROWID < ${beforeRowId}
  AND m.text IS NOT NULL
  AND trim(m.text) != ''
ORDER BY m.ROWID DESC
LIMIT ${limit};`;
	const { stdout } = await execFileAsync('sqlite3', ['-json', CHAT_DB_PATH, sql]);
	return JSON.parse(stdout.trim() || '[]').reverse();
}

function formatMessage(row) {
	const sender = row.is_from_me ? SENDER_LABELS['me'] : (SENDER_LABELS[row.handle] ?? row.handle);
	const ts = appleTimestampToDate(row.apple_ts);
	return `[${ts}] ${sender}: ${row.text}`;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

function supabaseHeaders() {
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' };
}

function supabaseUrl() {
	return process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
}

async function supabaseGet(path, params = {}) {
	const qs = new URLSearchParams(params).toString();
	const res = await fetch(`${supabaseUrl()}${path}?${qs}`, { headers: supabaseHeaders() });
	if (!res.ok) throw new Error(`Supabase GET ${path} ${res.status}: ${await res.text()}`);
	return res.json();
}

async function supabasePost(path, rows) {
	const res = await fetch(`${supabaseUrl()}${path}`, {
		method: 'POST',
		headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
		body: JSON.stringify(rows),
	});
	if (!res.ok) throw new Error(`Supabase POST ${path} ${res.status}: ${await res.text()}`);
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchWorkspaceId() {
	const rows = await supabaseGet('/rest/v1/workspaces', { select: 'id,name', limit: '10' });
	return rows.find(r => r.name?.toLowerCase().includes('lapm'))?.id ?? rows[0]?.id;
}

async function fetchOwners(workspaceId) {
	return supabaseGet('/rest/v1/owners', { select: 'id,name', workspace_id: `eq.${workspaceId}` });
}

async function fetchOwnerProperties(workspaceId) {
	return supabaseGet('/rest/v1/owner_properties', {
		select: 'owner_id,property_id,property:properties!property_id(name,address)',
		workspace_id: `eq.${workspaceId}`,
	});
}

async function fetchVendors(workspaceId) {
	return supabaseGet('/rest/v1/vendors', {
		select: 'name,trade',
		workspace_id: `eq.${workspaceId}`,
		order: 'preference_index.asc',
		limit: '30',
	});
}

async function fetchExistingNoteContents(workspaceId) {
	const rows = await supabaseGet('/rest/v1/owner_notes', {
		select: 'owner_id,property_id,content',
		workspace_id: `eq.${workspaceId}`,
		limit: '2000',
	});
	return new Set(rows.map(r => `${r.owner_id}|${r.property_id}|${normalize(r.content)}`));
}

// ── Name matching ─────────────────────────────────────────────────────────────

function normalize(s) {
	return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findOwner(owners, name) {
	const n = normalize(name);
	return owners.find(o => normalize(o.name) === n || normalize(o.name).includes(n) || n.includes(normalize(o.name)));
}

function findProperty(ownerProps, ownerId, nameOrAddress) {
	const n = normalize(nameOrAddress);
	return ownerProps.find(op =>
		op.owner_id === ownerId &&
		(normalize(op.property?.name).includes(n) || n.includes(normalize(op.property?.name)) ||
		 normalize(op.property?.address).includes(n) || n.includes(normalize(op.property?.address)))
	);
}

// ── OpenAI analysis ───────────────────────────────────────────────────────────

async function analyzeNewMessages(contextTranscript, newTranscript, owners, ownerProps, vendors) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	const ownerList = owners.map(o => {
		const props = ownerProps.filter(op => op.owner_id === o.id);
		const propNames = props.map(op => op.property?.name || op.property?.address).filter(Boolean).join(', ');
		return `- ${o.name}${propNames ? ` (properties: ${propNames})` : ''}`;
	}).join('\n');

	const vendorList = vendors.map(v => `- ${v.name}${v.trade ? ` (${v.trade})` : ''}`).join('\n');

	const systemPrompt =
		'You are analyzing a property management iMessage group chat to extract behavioral rules and owner preferences.\n\n' +
		'The participants are:\n' +
		'- Property Manager (Jose): makes final decisions on vendors and owner communications\n' +
		'- AI Agent: asks questions and suggests vendors on behalf of the property management company\n\n' +
		'Known owners and their properties:\n' + ownerList + '\n\n' +
		'Known vendors:\n' + vendorList + '\n\n' +
		'You will receive a CONTEXT section (recent prior messages for background) and a NEW MESSAGES section (the messages to analyze).\n' +
		'Extract behavioral rules and preferences from the NEW MESSAGES only — especially:\n' +
		'- Specific vendor assignments per owner or property\n' +
		'- Whether certain owners need to be consulted before approving work\n' +
		'- Approval thresholds or escalation rules\n' +
		'- Any other behavioral preference that should influence future vendor suggestions\n\n' +
		'Return a JSON object with a "notes" array. Each note must have:\n' +
		'  owner_name: string — must match one of the known owner names exactly\n' +
		'  property_names: string[] | null — list of property names, or null if the rule applies to all their properties\n' +
		'  note: string — concise, actionable rule (1-3 sentences)\n\n' +
		'Only include notes clearly supported by the NEW MESSAGES. Return an empty array if nothing new is found.';

	const userMessage =
		(contextTranscript ? `CONTEXT (prior messages):\n\n${contextTranscript}\n\n---\n\n` : '') +
		`NEW MESSAGES:\n\n${newTranscript}`;

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: OPENAI_MODEL,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userMessage },
			],
			max_tokens: MAX_TOKENS,
		}),
	});

	if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
	const data = await res.json();
	return JSON.parse(data.choices?.[0]?.message?.content ?? '{}').notes ?? [];
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollOnce(workspaceId, owners, ownerProps, vendors) {
	const newRows = await queryNewMessages(state.lastRowId);
	if (!newRows.length) {
		log('poll: no new messages', { lastRowId: state.lastRowId });
		return;
	}

	// Advance cursor regardless of whether PM said anything
	const maxRowId = Math.max(...newRows.map(r => r.rowid));
	state.lastRowId = maxRowId;
	await saveState();

	for (const row of newRows) {
		const sender = row.is_from_me ? SENDER_LABELS['me'] : (SENDER_LABELS[row.handle] ?? row.handle);
		log('new message', { rowid: row.rowid, sender, text: row.text?.slice(0, 80) });
	}

	// Only analyze if there's at least one Property Manager message
	const pmMessages = newRows.filter(r =>
		!r.is_from_me && SENDER_LABELS[r.handle] === 'Property Manager'
	);
	if (!pmMessages.length) {
		log('new messages but none from Property Manager, skipping analysis', { count: newRows.length });
		return;
	}

	log('analyzing new PM messages', { count: pmMessages.length, totalNew: newRows.length });

	const contextRows = await queryContextMessages(newRows[0].rowid, CONTEXT_WINDOW);
	const contextTranscript = contextRows.map(formatMessage).join('\n');
	const newTranscript = newRows.map(formatMessage).join('\n');

	const notes = await analyzeNewMessages(contextTranscript, newTranscript, owners, ownerProps, vendors);
	log('openai extracted notes', { count: notes.length });

	if (!notes.length) return;

	const existingNotes = await fetchExistingNoteContents(workspaceId);
	const toInsert = [];
	const unmatched = [];

	for (const note of notes) {
		const owner = findOwner(owners, note.owner_name);
		if (!owner) { unmatched.push(`owner "${note.owner_name}" not found`); continue; }

		const targetProps = note.property_names
			? note.property_names.map(pn => {
				const op = findProperty(ownerProps, owner.id, pn);
				if (!op) unmatched.push(`property "${pn}" for owner "${note.owner_name}" not found`);
				return op;
			}).filter(Boolean)
			: ownerProps.filter(op => op.owner_id === owner.id);

		if (!targetProps.length) { unmatched.push(`no properties resolved for owner "${note.owner_name}"`); continue; }

		for (const op of targetProps) {
			const dedupKey = `${owner.id}|${op.property_id}|${normalize(note.note)}`;
			if (existingNotes.has(dedupKey)) continue;
			toInsert.push({ workspace_id: workspaceId, owner_id: owner.id, property_id: op.property_id, content: note.note });
			existingNotes.add(dedupKey);
		}
	}

	if (unmatched.length) log('unmatched', { unmatched });

	if (toInsert.length) {
		await supabasePost('/rest/v1/owner_notes', toInsert);
		log('inserted notes', { count: toInsert.length });
	} else {
		log('all extracted notes already exist, nothing inserted');
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	await loadDotEnv(ROOT_ENV_PATH);
	await loadDotEnv(LOCAL_ENV_PATH);

	if (!supabaseUrl() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
		throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
	}

	await loadState();
	log(`imessage-read started (room=${ROOM_ID}, interval=${POLL_INTERVAL_MS}ms)`);

	const workspaceId = await fetchWorkspaceId();
	if (!workspaceId) throw new Error('No workspace found');
	log(`workspace: ${workspaceId}`);

	const [owners, ownerProps, vendors] = await Promise.all([
		fetchOwners(workspaceId),
		fetchOwnerProperties(workspaceId),
		fetchVendors(workspaceId),
	]);
	log('reference data loaded', { owners: owners.length, ownerProps: ownerProps.length, vendors: vendors.length });

	let running = false;
	setInterval(async () => {
		if (running) return;
		running = true;
		try {
			await pollOnce(workspaceId, owners, ownerProps, vendors);
		} catch (err) {
			log(`poll error: ${err.message}`);
		} finally {
			running = false;
		}
	}, POLL_INTERVAL_MS);
}

main().catch(err => { console.error(err); process.exit(1); });
