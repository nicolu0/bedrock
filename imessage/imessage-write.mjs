#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 5000;
const OPENAI_MODEL = 'gpt-4.1-mini';
const MAX_PROCESSED_IDS = 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const WORKSPACES = {
	test: '40d675ba-4dec-47dd-9222-79c0345c493f', // Andrew's Workspace
	prod: '2e4373a0-40b8-42c2-a873-b08c99dbf76a', // LAPM
};

const flag = process.argv.find(a => a.startsWith('--workspace=') || a === '--test' || a === '--prod');
const WORKSPACE_FILTER = flag === '--test' ? WORKSPACES.test
	: flag === '--prod' ? WORKSPACES.prod
	: flag?.startsWith('--workspace=') ? flag.split('=')[1]
	: null; // null = all workspaces
const ENV_PATH = path.join(SCRIPT_DIR, '..', '.env');
const STATE_PATH = path.join(SCRIPT_DIR, '.appfolio-poller-state.json');
const APPLESCRIPT_INJECT = path.join(SCRIPT_DIR, 'scripts', 'inject-draft.applescript');
const DRAFT_SERVER_PORT = parseInt(process.env.DRAFT_SERVER_PORT ?? '3456', 10);

// Find your chat GUID by running in Terminal:
//   sqlite3 ~/Library/Messages/chat.db \
//     "SELECT guid FROM chat WHERE room_name IS NOT NULL ORDER BY last_addressed_date DESC LIMIT 20;"
// Look for the group chat containing your 510, 949, and 310 contacts.
// Set JOSE_CHAT_GUID=iMessage;+;chat{UUID} in your .env

const state = {
	lastCheckedAt: null, // ISO string — only fetch issues created at or after this
	processedIds: {}     // issueId -> unix ms timestamp, prevents duplicate OpenAI calls
};

let pendingDraft = null; // { text, id, ts } — cleared when iPhone shortcut consumes it

// ── Env ──────────────────────────────────────────────────────────────────────

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

// ── State ─────────────────────────────────────────────────────────────────────

async function loadState() {
	try {
		const raw = await fs.readFile(STATE_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		state.lastCheckedAt = parsed.lastCheckedAt ?? null;
		state.processedIds = parsed.processedIds ?? {};
		log(`state loaded, watching from ${state.lastCheckedAt}`);
	} catch {
		// First run — start from now so we don't blast old work orders
		state.lastCheckedAt = new Date().toISOString();
		state.processedIds = {};
		await saveState();
		log(`state initialized, watching from ${state.lastCheckedAt}`);
	}
}

async function saveState() {
	const entries = Object.entries(state.processedIds).sort((a, b) => b[1] - a[1]);
	state.processedIds = Object.fromEntries(entries.slice(0, MAX_PROCESSED_IDS));
	await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg, extra = {}) {
	console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}

// ── Supabase ──────────────────────────────────────────────────────────────────

async function fetchNewIssues() {
	const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');

	// Pull issues_v2 with all agent_runs and joined display rows. Readiness
	// (both intake + vendor runs done) is filtered in JS so the cursor can
	// pause on not-yet-ready issues instead of skipping past them.
	const params = new URLSearchParams({
		select:
			'id,workspace_id,appfolio_id,name,description,urgent,created_at,property_id,vendor_id,' +
			'tenant:tenants!tenant_id(name),' +
			'property:properties!property_id(name),' +
			'unit:units!unit_id(name),' +
			'vendor:vendors!vendor_id(name),' +
			'agent_runs(agent_name,status)',
		order: 'created_at.asc',
		limit: '20',
	});
	if (WORKSPACE_FILTER) params.set('workspace_id', `eq.${WORKSPACE_FILTER}`);
	if (state.lastCheckedAt) params.set('created_at', `gte.${state.lastCheckedAt}`);

	const response = await fetch(`${supabaseUrl}/rest/v1/issues_v2?${params}`, {
		headers: {
			apikey: serviceRoleKey,
			Authorization: `Bearer ${serviceRoleKey}`,
			Accept: 'application/json',
		},
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Supabase ${response.status}: ${err}`);
	}

	return response.json();
}

function isReady(issue) {
	const runs = issue.agent_runs ?? [];
	const intake = runs.find((r) => r.agent_name === 'intake');
	const vendor = runs.find((r) => r.agent_name === 'vendor');
	return intake?.status === 'done' && vendor?.status === 'done';
}

// ── Vendors ───────────────────────────────────────────────────────────────────

// ── Owner notes ───────────────────────────────────────────────────────────────

async function fetchPropertyNotes(workspaceId, propertyId) {
	if (!propertyId) return [];
	const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	const params = new URLSearchParams({
		select: 'content',
		workspace_id: `eq.${workspaceId}`,
		property_id: `eq.${propertyId}`,
	});
	const response = await fetch(`${supabaseUrl}/rest/v1/owner_notes?${params}`, {
		headers: {
			apikey: serviceRoleKey,
			Authorization: `Bearer ${serviceRoleKey}`,
			Accept: 'application/json',
		},
	});
	if (!response.ok) return [];
	const data = await response.json();
	return Array.isArray(data) ? data.map(r => r.content) : [];
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function generateSuggestion({ description, name, tenantName, urgent, vendorName, propertyName, unitName, ownerNotes }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	const location = [propertyName, unitName ? `Unit ${unitName}` : null].filter(Boolean).join(', ');

	const workOrderLines = [
		location ? `Location: ${location}` : null,
		name ? `Title: ${name}` : null,
		description ? `Issue: ${description}` : null,
		tenantName ? `Tenant: ${tenantName}` : null,
		urgent ? 'Priority: URGENT' : null,
		vendorName ? `Recommended vendor: ${vendorName}` : null,
	].filter(Boolean);

	log('calling openai', { model: OPENAI_MODEL, name });
	const t0 = Date.now();

	const response = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			messages: [
				{
					role: 'system',
					content:
						'You write property management groupchat messages sent via iMessage. ' +
						'Always split your response into separate iMessages using %%%% between each one.\n\n' +
						'Example output:\n' +
						'Tenant at Sunset Apts, unit 4 reported a leaking kitchen faucet.%%%%Should we send Yonic for this?\n\n' +
						'Another example:\n' +
						'Gardener noticed the side gate latch is broken at Oak Manor, unit 2.%%%%Should we send LA Hydro Jet?\n\n' +
						'Rules:\n' +
						'- First message: 1-2 sentence summary. Natural tone. Include property, unit, and issue. Tenant name if available. No work order number.\n' +
						(ownerNotes?.length
							? '- Second message: casual vendor suggestion that follows the owner/property notes below. "Should we send [Vendor]?"\n' +
							  '- Owner/property notes (follow these strictly):\n' +
							  ownerNotes.map(n => `  * ${n}`).join('\n') + '\n'
							: '- Second message: ask whether the owner needs to be contacted, then suggest the vendor. Example: "Do we need to contact the owner for this or can we send Abraham?"\n'
						) +
						'- Use the recommended vendor from the work order when one is provided. The selection has already been made.\n' +
						'- Vendor name format: use first name only for individual people (e.g. "Yonic", "Abraham"). Use the full name for companies (e.g. "LA Hydro Jet", "Drain Specialist").\n' +
						'- Plain text only. No bullet points, no markdown. Always use %%%% to separate messages.',
				},
				{
					role: 'user',
					content: workOrderLines.join('\n'),
				},
			],
			max_tokens: 200,
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`OpenAI ${response.status}: ${err}`);
	}

	const data = await response.json();
	const suggestion = data.choices?.[0]?.message?.content?.trim() ?? '';
	log('openai responded', { ms: Date.now() - t0, suggestion });
	return suggestion;
}

// ── Draft delivery ────────────────────────────────────────────────────────────

// Part 1: inject text into the Messages input box for the group chat on Mac Mini.
// Uses clipboard+paste so the user can review and hit Send manually.
async function injectDraft(text) {
	const chatGuid = process.env.JOSE_CHAT_GUID;
	if (!chatGuid) {
		log('JOSE_CHAT_GUID not set — skipping Mac Messages injection');
		return;
	}
	try {
		const { stdout, stderr } = await execFileAsync('osascript', [APPLESCRIPT_INJECT, chatGuid, text]);
		if (stdout?.trim()) log(`inject applescript: ${stdout.trim()}`);
		if (stderr?.trim()) log(`inject applescript stderr: ${stderr.trim()}`);
	} catch (err) {
		log(`inject applescript error: ${err.message}`);
	}
}

// Part 2: HTTP server that the iPhone Shortcut polls.
// GET  /draft         → { text, id } or { text: null }
// POST /draft/consume → clears pendingDraft, returns 204
function startDraftServer(port) {
	const server = createServer((req, res) => {
		const { pathname } = new URL(req.url, 'http://localhost');

		if (req.method === 'GET' && pathname === '/draft') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(pendingDraft
				? { text: pendingDraft.text, id: pendingDraft.id }
				: { text: null }
			));
			return;
		}

		if (req.method === 'POST' && pathname === '/draft/consume') {
			pendingDraft = null;
			res.writeHead(204);
			res.end();
			return;
		}

		res.writeHead(404);
		res.end();
	});

	server.listen(port, '0.0.0.0', () => {
		log(`draft server listening on :${port}`);
	});
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollOnce() {
	const issues = await fetchNewIssues();
	if (!issues.length) return;

	for (const issue of issues) {
		// Pause cursor advancement on the first not-yet-ready issue so we
		// re-poll it next tick instead of skipping past it forever.
		if (!isReady(issue)) {
			log('issue not ready, waiting for agents', { id: issue.id, appfolio_id: issue.appfolio_id });
			break;
		}

		if (!state.lastCheckedAt || issue.created_at > state.lastCheckedAt) {
			state.lastCheckedAt = issue.created_at;
		}

		// Skip if already processed (dedup)
		if (state.processedIds[issue.id]) continue;

		// Mark immediately so a crash mid-flight doesn't retry
		state.processedIds[issue.id] = Date.now();
		await saveState();

		log('new work order', { id: issue.id, appfolio_id: issue.appfolio_id });

		const description = issue.description || issue.name || null;
		const tenantName = issue.tenant?.name ?? null;
		const vendorName = issue.vendor?.name ?? null;

		try {
			const ownerNotes = await fetchPropertyNotes(issue.workspace_id, issue.property_id ?? null);
			if (ownerNotes.length) log('owner notes found', { propertyId: issue.property_id, count: ownerNotes.length });
			const suggestion = await generateSuggestion({
				description,
				name: issue.name,
				tenantName,
				urgent: !!issue.urgent,
				vendorName,
				propertyName: issue.property?.name ?? null,
				unitName: issue.unit?.name ?? null,
				ownerNotes,
			});

			if (!suggestion) { log('empty suggestion, skipping'); continue; }

			// Join parts with double newline so the draft reads naturally in the input box
			const parts = (suggestion.includes('%%%%')
				? suggestion.split('%%%%')
				: suggestion.split(/\n\n+/)
			).map(p => p.trim()).filter(Boolean);
			const draftText = parts.join('\n\n');

			log('draft ready', { id: issue.id, parts: parts.length, text: draftText });

			// Part 2: store for iPhone Shortcut polling
			pendingDraft = { text: draftText, id: issue.id, ts: Date.now() };

			// Part 1: inject into Mac Messages input box
			await injectDraft(draftText);
		} catch (err) {
			log(`error processing issue ${issue.id}: ${err.message}`);
		}
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	await loadDotEnv();
	await loadState();
	startDraftServer(DRAFT_SERVER_PORT);
	log(`poller started (interval=${POLL_INTERVAL_MS}ms, workspace=${WORKSPACE_FILTER ?? 'all'})`);

	let running = false;
	setInterval(async () => {
		if (running) return;
		running = true;
		try {
			await pollOnce();
		} catch (err) {
			log(`poll error: ${err.message}`);
		} finally {
			running = false;
		}
	}, POLL_INTERVAL_MS);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
