#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const APPLESCRIPT_SEND = path.join(SCRIPT_DIR, 'scripts', 'send.applescript');

const state = {
	lastCheckedAt: null, // ISO string — only fetch issues created at or after this
	processedIds: {}     // issueId -> unix ms timestamp, prevents duplicate OpenAI calls
};

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

	const params = new URLSearchParams({
		select: 'id,workspace_id,service_request_number,name,description,urgent,created_at,tenant:tenants!tenant_id(name),property:properties!property_id(name),unit:units!unit_id(name)',
		source: 'eq.appfolio',
		order: 'created_at.asc',
		limit: '20',
	});
	if (WORKSPACE_FILTER) params.set('workspace_id', `eq.${WORKSPACE_FILTER}`);
	if (state.lastCheckedAt) {
		// gte so we don't miss issues with the same-millisecond timestamp;
		// processedIds handles the resulting duplicates
		params.set('created_at', `gte.${state.lastCheckedAt}`);
	}

	const response = await fetch(`${supabaseUrl}/rest/v1/issues?${params}`, {
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

// ── Vendors ───────────────────────────────────────────────────────────────────

async function fetchVendors(workspaceId) {
	const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	const params = new URLSearchParams({
		select: 'name,trade,note',
		workspace_id: `eq.${workspaceId}`,
		order: 'preference_index.asc',
		limit: '30',
	});
	const response = await fetch(`${supabaseUrl}/rest/v1/vendors?${params}`, {
		headers: {
			apikey: serviceRoleKey,
			Authorization: `Bearer ${serviceRoleKey}`,
			Accept: 'application/json',
		},
	});
	if (!response.ok) return [];
	return response.json();
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function generateSuggestion({ serviceRequestNumber, description, tenantName, urgent, vendors, propertyName, unitName }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	const location = [propertyName, unitName ? `Unit ${unitName}` : null].filter(Boolean).join(', ');

	const workOrderLines = [
		location ? `Location: ${location}` : null,
		description ? `Issue: ${description}` : null,
		tenantName ? `Tenant: ${tenantName}` : null,
		urgent ? 'Priority: URGENT' : null,
	].filter(Boolean);

	const vendorLines = vendors.length
		? vendors.map(v => [v.name, v.trade, v.note].filter(Boolean).join(' — ')).join('\n')
		: 'No vendors on file.';

	log('calling openai', { model: OPENAI_MODEL, wo: serviceRequestNumber });
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
						'Tenant at Sunset Apts, unit 4 reported a leaking kitchen faucet.%%%%Should we send Yonic Herrera for this?\n\n' +
						'Another example:\n' +
						'Gardener noticed the side gate latch is broken at Oak Manor, unit 2.%%%%Should we send Kori or Ismael?\n\n' +
						'Rules:\n' +
						'- First message: 1-2 sentence summary. Natural tone. Include property, unit, and issue. Tenant name if available. No work order number.\n' +
						'- Second message: casual vendor suggestion. "Should we send [Vendor]?" or "Should we send [A] or [B]?"\n' +
						'- Vendor notes are instructions — follow them strictly. If a note says "always send first" for this property, pick that vendor.\n' +
						'- Default to a handyman for simple repairs (battery replacement, minor fixes, general maintenance). Only pick a specialist (plumber, electrician, HVAC) when the issue clearly requires licensed trade work.\n' +
						'- Only suggest two vendors if no note gives a clear preference and both are genuinely equally suited.\n' +
						'- Plain text only. No bullet points, no markdown. Always use %%%% to separate messages.',
				},
				{
					role: 'user',
					content: `${workOrderLines.join('\n')}\n\nAvailable vendors:\n${vendorLines}`,
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

// ── iMessage ──────────────────────────────────────────────────────────────────

async function sendIMessage(handle, text) {
	try {
		const { stdout, stderr } = await execFileAsync('osascript', [APPLESCRIPT_SEND, '', handle, text]);
		if (stdout?.trim()) log(`applescript: ${stdout.trim()}`);
		if (stderr?.trim()) log(`applescript stderr: ${stderr.trim()}`);
		return true;
	} catch (err) {
		log(`applescript error: ${err.message}`);
		return false;
	}
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollOnce() {
	const issues = await fetchNewIssues();
	if (!issues.length) return;

	for (const issue of issues) {
		// Advance cursor regardless so we don't re-query old issues forever
		if (!state.lastCheckedAt || issue.created_at > state.lastCheckedAt) {
			state.lastCheckedAt = issue.created_at;
		}

		// Skip if already processed (dedup)
		if (state.processedIds[issue.id]) continue;

		// Mark immediately so a crash mid-flight doesn't retry
		state.processedIds[issue.id] = Date.now();
		await saveState();

		log('new work order', { id: issue.id, wo: issue.service_request_number });

		const description = issue.description || issue.name || null;
		const tenantName = issue.tenant?.name ?? null;
		const targetPhone = process.env.TARGET_PHONE_NUMBER;
		if (!targetPhone) { log('TARGET_PHONE_NUMBER not set'); continue; }

		try {
			const vendors = await fetchVendors(issue.workspace_id);
			const suggestion = await generateSuggestion({
				serviceRequestNumber: issue.service_request_number,
				description,
				tenantName,
				urgent: !!issue.urgent,
				vendors,
				propertyName: issue.property?.name ?? null,
				unitName: issue.unit?.name ?? null,
			});

			if (!suggestion) { log('empty suggestion, skipping'); continue; }

			const parts = (suggestion.includes('%%%%')
				? suggestion.split('%%%%')
				: suggestion.split(/\n\n+/)
			).map(p => p.trim()).filter(Boolean);
			for (let i = 0; i < parts.length; i++) {
				log(`sending part ${i + 1}/${parts.length}`, { to: targetPhone, text: parts[i] });
				await sendIMessage(targetPhone, parts[i]);
				if (i < parts.length - 1) await new Promise(r => setTimeout(r, 3000));
			}
		} catch (err) {
			log(`error processing issue ${issue.id}: ${err.message}`);
		}
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	await loadDotEnv();
	await loadState();
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
