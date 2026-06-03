#!/usr/bin/env node
// Smoke test v2 — run a longer run of recurring-vendor (Garcia's Handyman)
// observations sequentially to confirm the belief-former bootstraps a CREATE
// out of cold start, then reinforces it. Confirms machinery end-to-end.

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
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
			if (!(k in process.env)) process.env[k] = v;
		}
	} catch {}
}
await loadDotEnv(path.join(REPO_ROOT, '.env'));
await loadDotEnv(path.join(AGENT_ROOT, '.env'));

const WORKSPACE = '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7';
const { supabaseEnv } = await import('../core/supabase.mjs');
const { runBeliefFormer } = await import('../core/belief-former.mjs');
const { url, key } = supabaseEnv();
const H = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };

async function countBeliefs() {
	const res = await fetch(`${url}/rest/v1/beliefs?select=id&workspace_id=eq.${WORKSPACE}`, {
		headers: { ...H, Prefer: 'count=exact', Range: '0-0' }
	});
	const cr = res.headers.get('content-range');
	return cr ? Number(cr.split('/')[1]) : -1;
}

const res = await fetch(
	`${url}/rest/v1/observations?select=id,ts,summary,belief_evidence(observation_id)&workspace_id=eq.${WORKSPACE}&order=ts.asc&limit=2000`,
	{ headers: H }
);
const allObs = await res.json();
const pending = allObs.filter((r) => !r.belief_evidence || r.belief_evidence.length === 0);
const garcia = pending.filter((o) => /garcia/i.test(o.summary || '')).slice(0, 5);
console.log(`testing ${garcia.length} Garcia obs sequentially`);

const before = await countBeliefs();
for (const obs of garcia) {
	const result = await runBeliefFormer(WORKSPACE, obs.id);
	if (result?.error) {
		console.error(`SMOKE FAIL: ${result.error}`);
		process.exit(2);
	}
	const ops = (result?.ops ?? []).map((o) => `${o.action}${o.belief_id ? '/' + o.belief_id.slice(0, 8) : ''}${o.claim ? ' "' + o.claim.slice(0, 60) + '"' : ''}`);
	console.log(`  ${obs.id.slice(0, 8)}: ${ops.join('; ') || 'noop'}`);
}
const after = await countBeliefs();
console.log(`\nbeliefs: ${before} -> ${after} (Δ${after - before})`);
process.exit(after - before >= 1 ? 0 : 3);
