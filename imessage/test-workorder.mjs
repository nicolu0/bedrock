#!/usr/bin/env node
// Inserts a fake AppFolio work order into Supabase to test the poller.
// Run: node imessage/test-workorder.mjs
// After ~5s the poller should pick it up and text your 510.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(SCRIPT_DIR, '..', '.env');

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
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
				value = value.slice(1, -1);
			if (!(key in process.env)) process.env[key] = value;
		}
	} catch {}
}

await loadDotEnv();

const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
	console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
	process.exit(1);
}

const headers = {
	apikey: serviceRoleKey,
	Authorization: `Bearer ${serviceRoleKey}`,
	'Content-Type': 'application/json',
	Accept: 'application/json',
};

// Grab any workspace_id to satisfy the FK
const wsRes = await fetch(`${supabaseUrl}/rest/v1/workspaces?select=id&limit=1`, { headers });
const workspaces = await wsRes.json();
if (!workspaces.length) {
	console.error('No workspaces found');
	process.exit(1);
}
const workspaceId = workspaces[0].id;
console.log(`Using workspace: ${workspaceId}`);

const fakeWoId = `test-${Date.now()}`;
const issue = {
	workspace_id: workspaceId,
	source: 'appfolio',
	appfolio_id: fakeWoId,
	service_request_number: `TEST-${Math.floor(Math.random() * 9000) + 1000}`,
	name: 'Water heater not working in unit',
	description: 'Tenant reports no hot water since yesterday morning. Unit 8, 292 Main St.',
	status: 'todo',
	urgent: false,
};

const res = await fetch(`${supabaseUrl}/rest/v1/issues`, {
	method: 'POST',
	headers: { ...headers, Prefer: 'return=representation' },
	body: JSON.stringify(issue),
});

if (!res.ok) {
	const err = await res.text();
	console.error(`Insert failed (${res.status}):`, err);
	process.exit(1);
}

const [inserted] = await res.json();
console.log(`Inserted issue id=${inserted.id} — poller should pick it up within 5s`);
