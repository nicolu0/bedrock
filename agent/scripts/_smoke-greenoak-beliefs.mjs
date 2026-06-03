#!/usr/bin/env node
// SMOKE TEST — belief-former on Green Oak's memory graph.
// Feeds a DELIBERATE sample of ~8 observations sequentially through
// runBeliefFormer and reports the ops per observation. NOT a full run.
//
// Sample is chosen so repeat-vendor observations arrive back-to-back: the
// first should CREATE a belief, the second should ATTACH (reinforce) it —
// proving consolidation works across observations.
//
// Usage: node agent/scripts/_smoke-greenoak-beliefs.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(AGENT_ROOT, '..');

async function loadDotEnv(p) {
	try {
		const raw = await fs.readFile(p, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith('#')) continue;
			const i = t.indexOf('=');
			if (i <= 0) continue;
			const k = t.slice(0, i).trim();
			let v = t.slice(i + 1).trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
				v = v.slice(1, -1);
			}
			if (!(k in process.env)) process.env[k] = v;
		}
	} catch {
		/* optional */
	}
}

await loadDotEnv(path.join(REPO_ROOT, '.env'));

for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) {
	if (!process.env[k]) {
		console.error(`env ${k} not set; source the repo .env first`);
		process.exit(2);
	}
}
if (!process.env.PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) {
	console.error('env PUBLIC_SUPABASE_URL or SUPABASE_URL not set');
	process.exit(2);
}

const WORKSPACE = '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7';

// Late import so env is loaded first.
const { runBeliefFormer } = await import('../core/belief-former.mjs');

// Deliberate, ordered sample. Repeat vendors back-to-back (CREATE then ATTACH).
const SAMPLE = [
	{ obs_id: '765f1538-5ea2-4ec7-a769-949e318eea2d', wo: '1250-1', vendor: 'Rightway Apartment Service', property: '1827 S Barrington Ave #107', summary: 'Rightway handled weak fridge door seal.' },
	{ obs_id: '4640d008-7c31-4598-b2f9-7ef4aaa32636', wo: '1284-1', vendor: 'Rightway Apartment Service', property: '9th St Bungalow Home LLC', summary: 'Rightway handled back-entrance flood light needing sensor.' },
	{ obs_id: '1c380822-0faa-414d-b8c8-a41f9411d042', wo: '1261-1', vendor: 'A1 Service Appliances, Inc.', property: '9033 Dicks St', summary: 'A1 handled washer/dryer with no cold water.' },
	{ obs_id: 'c09d3f16-8ed2-4652-9c3c-5b402504363f', wo: '1349-1', vendor: 'A1 Service Appliances, Inc.', property: '829 Bunker Hill', summary: 'A1 handled AC not cooling.' },
	{ obs_id: '0e83cc1c-9293-4c10-b184-b72542eba3e8', wo: '1239-1', vendor: "Garcia's Handyman and Cleaning Services LLC.", property: '9206 S Hoover St', summary: 'Garcia replaced bulbs, swapped bedroom lock for door knob.' },
	{ obs_id: '2e528cb2-5b7e-486c-8e34-b71e2273b659', wo: '1242-1', vendor: "Garcia's Handyman and Cleaning Services LLC.", property: '505 N Belmont Ave', summary: 'Garcia gave fence bid for owner submission.' },
	{ obs_id: 'e4bf42f0-012c-447a-a9c0-81341ff7b77a', wo: '1366-4', vendor: 'Bresnahan Rain Gutter Cleaning', property: '829 Bunker Hill', summary: 'Bresnahan estimated reseating fallen gutter (singleton).' },
	{ obs_id: '77c2e480-b948-4043-92a5-9a724f45655d', wo: '1380-2', vendor: 'Tony Germann', property: '2419 S Cochran Ave', summary: 'Tony Germann handled intermittent heater + estimate (singleton).' }
];

const results = [];
for (const s of SAMPLE) {
	process.stdout.write(`\n[feed] ${s.wo} ${s.vendor} (${s.obs_id.slice(0, 8)}) ... `);
	try {
		const out = await runBeliefFormer(WORKSPACE, s.obs_id);
		const ops = out?.ops ?? [];
		const err = out?.error ?? null;
		const tally = ops.length ? ops.map((o) => o.action).join(',') : 'noop';
		process.stdout.write(`${tally}${err ? ` ERROR:${err}` : ''}`);
		results.push({ ...s, ops, error: err });
	} catch (e) {
		process.stdout.write(`THROWN:${e.message}`);
		results.push({ ...s, ops: [], error: e.message });
	}
}

console.log('\n\n===== PER-OBSERVATION OPS =====');
console.log(JSON.stringify(results, null, 2));
