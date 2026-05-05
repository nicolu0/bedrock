#!/usr/bin/env node
// One-shot backfill of today's real AppFolio WOs after the issues_v2 wipe.
// POSTs synthetic payloads to intake-agent — same shape as pubsub-hook would.
// Each call runs the full pipeline (intake → vendor → AppFolio enrichment)
// and creates a real issues_v2 row with a fresh now() timestamp.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(SCRIPT_DIR, '..', '.env');

async function loadEnv() {
	const raw = await fs.readFile(ENV_PATH, 'utf8');
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const idx = trimmed.indexOf('=');
		if (idx <= 0) continue;
		const key = trimmed.slice(0, idx).trim();
		let value = trimmed.slice(idx + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (!(key in process.env)) process.env[key] = value;
	}
}

const WORKSPACE_ID = '2e4373a0-40b8-42c2-a873-b08c99dbf76a';

// From today's inbox. Property number = first numeric segment after the
// dash-delimited title in "WO #SRN-N - Title - <prop> - <unit>".
const WORK_ORDERS = [
	{ srn: '7621', propNumber: '156', title: 'Toilet Is Running Continuously' },
	{ srn: '7622', propNumber: '271', title: 'Smoke Detector' },
	{ srn: '7623', propNumber: '271', title: 'Water Pressure' },
	{ srn: '7625', propNumber: '272', title: 'Water Heater' },
	{ srn: '7627', propNumber: '220', title: 'Garbage Disposal' },
];

async function dispatchOne(supabaseUrl, serviceKey, wo) {
	const gmailMessageId = `backfill-${wo.srn}-${Date.now()}`;
	const payload = {
		workspaceId: WORKSPACE_ID,
		serviceRequestNumber: `${wo.srn}-1`,
		appfolioPropertyId: wo.propNumber,
		subject: `WO #${wo.srn}-1 - ${wo.title} - ${wo.propNumber}`,
		body: '',
		gmailMessageId,
	};
	console.log(`→ SRN ${wo.srn} (${wo.title}) — dispatching...`);
	const t0 = Date.now();
	const res = await fetch(`${supabaseUrl}/functions/v1/intake-agent`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: serviceKey,
			Authorization: `Bearer ${serviceKey}`,
		},
		body: JSON.stringify(payload),
	});
	const ms = Date.now() - t0;
	const text = await res.text();
	if (!res.ok) {
		console.error(`  ✗ ${res.status} after ${ms}ms — ${text.slice(0, 300)}`);
		return false;
	}
	console.log(`  ✓ ${res.status} in ${ms}ms — ${text.slice(0, 300)}`);
	return true;
}

async function main() {
	await loadEnv();
	const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !serviceKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

	for (const wo of WORK_ORDERS) {
		await dispatchOne(supabaseUrl, serviceKey, wo);
		// Small pause so vendor-agent and enrichment finish before next call.
		await new Promise(r => setTimeout(r, 1500));
	}
	console.log('\nBackfill complete.');
}

main().catch(err => {
	console.error('Backfill failed:', err);
	process.exit(1);
});
