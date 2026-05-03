#!/usr/bin/env node
// One-shot script: reads owner-chat.csv, extracts behavioral notes via OpenAI,
// and inserts them into the owner_notes table in Supabase.
// Re-running is safe — existing (owner_id, property_id) pairs are skipped.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_ENV_PATH = path.join(SCRIPT_DIR, '..', '.env');
const LOCAL_ENV_PATH = path.join(SCRIPT_DIR, '.env');
const CSV_PATH = path.join(SCRIPT_DIR, 'owner-chat.csv');
const OPENAI_MODEL = 'gpt-4.1';

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
	// Prefer LAPM prod workspace if present
	return rows.find(r => r.name?.toLowerCase().includes('lapm'))?.id ?? rows[0]?.id;
}

async function fetchOwners(workspaceId) {
	return supabaseGet('/rest/v1/owners', { select: 'id,name', workspace_id: `eq.${workspaceId}` });
}

async function fetchOwnerProperties(workspaceId) {
	// Returns [{ owner_id, property_id, property: { name, address } }]
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

async function fetchExistingNotes(workspaceId) {
	const rows = await supabaseGet('/rest/v1/owner_notes', {
		select: 'owner_id,property_id',
		workspace_id: `eq.${workspaceId}`,
		limit: '1000',
	});
	// Set of "ownerId|propertyId" strings for dedup
	return new Set(rows.map(r => `${r.owner_id}|${r.property_id}`));
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCSV(raw) {
	const lines = raw.trim().split('\n');
	const headers = lines[0].split(',');
	return lines.slice(1).map(line => {
		const cols = [];
		let cur = '', inQuote = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (ch === '"' && !inQuote) { inQuote = true; continue; }
			if (ch === '"' && inQuote && line[i + 1] === '"') { cur += '"'; i++; continue; }
			if (ch === '"' && inQuote) { inQuote = false; continue; }
			if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; continue; }
			cur += ch;
		}
		cols.push(cur);
		return Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? '']));
	});
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

async function analyzeChat(transcript, owners, ownerProps, vendors) {
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
		'Extract all recurring patterns, rules, or preferences you can identify from the chat — especially:\n' +
		'- Specific vendor assignments per owner or property (e.g. "always use Kori for Harrison LLC")\n' +
		'- Whether certain owners need to be consulted before approving work\n' +
		'- Approval thresholds or escalation rules\n' +
		'- Any other behavioral preference that should influence future vendor suggestions\n\n' +
		'Return a JSON object with a "notes" array. Each note must have:\n' +
		'  owner_name: string — must match one of the known owner names exactly\n' +
		'  property_names: string[] | null — list of property names from the owner\'s list, or null if the rule applies to all their properties\n' +
		'  note: string — concise, actionable rule (1-3 sentences)\n\n' +
		'Only include notes that are clearly supported by the conversation. Do not invent rules.';

	const userMessage = 'Chat transcript:\n\n' + transcript;

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
			max_tokens: 2000,
		}),
	});

	if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
	const data = await res.json();
	const raw = data.choices?.[0]?.message?.content ?? '{}';
	return JSON.parse(raw).notes ?? [];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	await loadDotEnv(ROOT_ENV_PATH);
	await loadDotEnv(LOCAL_ENV_PATH);

	const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl() || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');

	console.log('Fetching workspace and reference data...');
	const workspaceId = await fetchWorkspaceId();
	if (!workspaceId) throw new Error('No workspace found');
	console.log(`Workspace: ${workspaceId}`);

	const [owners, ownerProps, vendors, existingNotes] = await Promise.all([
		fetchOwners(workspaceId),
		fetchOwnerProperties(workspaceId),
		fetchVendors(workspaceId),
		fetchExistingNotes(workspaceId),
	]);

	console.log(`Loaded ${owners.length} owners, ${ownerProps.length} owner-property links, ${vendors.length} vendors`);

	const csvRaw = await fs.readFile(CSV_PATH, 'utf8');
	const rows = parseCSV(csvRaw).filter(r => r.message && !r.message.startsWith('Liked '));
	const transcript = rows.map(r => `[${r.timestamp}] ${r.sender}: ${r.message}`).join('\n');
	console.log(`Analyzing ${rows.length} messages (reactions filtered out)...`);

	const notes = await analyzeChat(transcript, owners, ownerProps, vendors);
	console.log(`\nOpenAI extracted ${notes.length} notes:`);
	notes.forEach((n, i) => console.log(`  ${i + 1}. [${n.owner_name}] ${n.property_names ? n.property_names.join(', ') : 'all properties'}: ${n.note}`));

	const toInsert = [];
	const unmatched = [];

	for (const note of notes) {
		const owner = findOwner(owners, note.owner_name);
		if (!owner) {
			unmatched.push(`owner "${note.owner_name}" not found`);
			continue;
		}

		const targetProps = note.property_names
			? note.property_names.map(pn => {
				const op = findProperty(ownerProps, owner.id, pn);
				if (!op) unmatched.push(`property "${pn}" for owner "${note.owner_name}" not found`);
				return op;
			}).filter(Boolean)
			: ownerProps.filter(op => op.owner_id === owner.id);

		if (!targetProps.length) {
			unmatched.push(`no properties resolved for owner "${note.owner_name}"`);
			continue;
		}

		for (const op of targetProps) {
			const dedupKey = `${owner.id}|${op.property_id}`;
			if (existingNotes.has(dedupKey)) continue;
			toInsert.push({
				workspace_id: workspaceId,
				owner_id: owner.id,
				property_id: op.property_id,
				content: note.note,
			});
			existingNotes.add(dedupKey); // prevent dupes within this run
		}
	}

	console.log(`\nInserting ${toInsert.length} notes (${existingNotes.size - toInsert.length} already existed)...`);
	if (unmatched.length) console.warn('Unmatched:', unmatched);

	if (toInsert.length) {
		await supabasePost('/rest/v1/owner_notes', toInsert);
		console.log('Done.');
	} else {
		console.log('Nothing new to insert.');
	}
}

main().catch(err => { console.error(err); process.exit(1); });
