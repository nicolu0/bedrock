#!/usr/bin/env node
// One-off: run the belief-former across observations that have no edges
// pointing to them (i.e. were never consolidated). Use after phase 2 if the
// extractor wrote observations without firing the belief-former.
//
// Usage:
//   node agent/scripts/backfill-beliefs.mjs --workspace=prod [--limit=N]

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
await loadDotEnv(path.join(AGENT_ROOT, '.env'));

const args = process.argv.slice(2);
function arg(name) {
	for (const a of args) {
		if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
		if (a === `--${name}`) return true;
	}
	return null;
}

const WORKSPACE_LABELS = {
	prod: '2e4373a0-40b8-42c2-a873-b08c99dbf76a',
	test: '40d675ba-4dec-47dd-9222-79c0345c493f'
};

const wsArg = arg('workspace');
if (!wsArg) {
	console.error('usage: --workspace=<prod|test|uuid> [--limit=N]');
	process.exit(2);
}
const workspace_id = WORKSPACE_LABELS[wsArg] ?? wsArg;
const limit = arg('limit') ? Number(arg('limit')) : Infinity;

const { supabaseEnv } = await import('../supabase.mjs');
const { runBeliefFormer } = await import('../core/belief-former.mjs');

const env = process.env;
const url = env.PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const h = {
	apikey: env.SUPABASE_SERVICE_ROLE_KEY,
	Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
	Accept: 'application/json'
};

// Observations that have NO belief_evidence row — they've never been
// consolidated. Sort by oldest first so the belief-former sees the natural
// chronology.
const res = await fetch(
	`${url}/rest/v1/observations?select=id,ts,summary,belief_evidence(observation_id)&workspace_id=eq.${workspace_id}&order=ts.asc&limit=2000`,
	{ headers: h }
);
if (!res.ok) {
	console.error(`fetch observations: ${res.status} ${await res.text()}`);
	process.exit(1);
}
const rows = await res.json();
const pending = rows.filter((r) => !r.belief_evidence || r.belief_evidence.length === 0);
console.log(`workspace ${wsArg}: ${rows.length} total observations, ${pending.length} unconsolidated`);

const target = Math.min(pending.length, limit);
let done = 0;
for (const obs of pending) {
	if (done >= limit) break;
	try {
		const result = await runBeliefFormer(workspace_id, obs.id);
		const ops = result?.ops ?? [];
		const summary = ops.map((op) => op.action).join(',') || 'noop';
		console.log(
			`  [+] ${obs.id.slice(0, 8)} (${(obs.summary || '').slice(0, 70)}) → ${summary}`
		);
	} catch (err) {
		console.error(`  [!] ${obs.id.slice(0, 8)} failed: ${err.message}`);
	}
	done++;
}

console.log(`\ndone: processed=${done}/${target}`);
