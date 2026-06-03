#!/usr/bin/env node
// Smoke test for the Green Oak belief-former run. Picks 2 observations,
// runs runBeliefFormer on each, then confirms >=1 belief was created and
// linked to entities. Exits non-zero with a clear message on failure.

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

const WORKSPACE = '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7';

for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) {
	if (!process.env[k]) {
		console.error(`SMOKE FAIL: env ${k} not set`);
		process.exit(2);
	}
}
if (!process.env.PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) {
	console.error('SMOKE FAIL: PUBLIC_SUPABASE_URL / SUPABASE_URL not set');
	process.exit(2);
}

const { supabaseEnv } = await import('../core/supabase.mjs');
const { runBeliefFormer } = await import('../core/belief-former.mjs');
const { url, key } = supabaseEnv();
const H = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };

async function countBeliefs() {
	const res = await fetch(
		`${url}/rest/v1/beliefs?select=id&workspace_id=eq.${WORKSPACE}`,
		{ headers: { ...H, Prefer: 'count=exact', Range: '0-0' } }
	);
	const cr = res.headers.get('content-range');
	return cr ? Number(cr.split('/')[1]) : -1;
}

async function countBeliefEntities() {
	// belief_entities has no workspace_id; count edges for this ws's beliefs.
	const res = await fetch(
		`${url}/rest/v1/belief_entities?select=belief_id,belief:beliefs!inner(workspace_id)&belief.workspace_id=eq.${WORKSPACE}`,
		{ headers: { ...H, Prefer: 'count=exact', Range: '0-0' } }
	);
	const cr = res.headers.get('content-range');
	return cr ? Number(cr.split('/')[1]) : -1;
}

// Pick 2 unconsolidated observations (no belief_evidence yet), ts ascending.
const res = await fetch(
	`${url}/rest/v1/observations?select=id,ts,summary,belief_evidence(observation_id)&workspace_id=eq.${WORKSPACE}&order=ts.asc&limit=2000`,
	{ headers: H }
);
if (!res.ok) {
	console.error(`SMOKE FAIL: fetch observations ${res.status} ${await res.text()}`);
	process.exit(2);
}
const allObs = await res.json();
const pending = allObs.filter((r) => !r.belief_evidence || r.belief_evidence.length === 0);
console.log(`total obs in ws: ${allObs.length}, unconsolidated: ${pending.length}`);

if (pending.length === 0) {
	console.error('SMOKE FAIL: 0 unconsolidated observations to test on');
	process.exit(2);
}

// Pick 2 obs about the SAME recurring vendor so the 2nd should consolidate
// into a CREATE (entity overlap + similar claim direction). Garcia's Handyman
// is the dominant recurring vendor in this dataset. Fall back to first-2 if
// the heuristic finds none.
const garcia = pending.filter((o) => /garcia/i.test(o.summary || ''));
const sample = garcia.length >= 2 ? garcia.slice(0, 2) : pending.slice(0, 2);
console.log(`smoke sample: ${sample.map((o) => o.id.slice(0, 8)).join(', ')} (${garcia.length >= 2 ? 'recurring-vendor' : 'first-2'})`);
const beliefsBefore = await countBeliefs();
const edgesBefore = await countBeliefEntities();
console.log(`beliefs before: ${beliefsBefore}, belief_entities before: ${edgesBefore}`);

for (const obs of sample) {
	console.log(`\n--- runBeliefFormer on ${obs.id.slice(0, 8)} (${(obs.summary || '').slice(0, 70)})`);
	const result = await runBeliefFormer(WORKSPACE, obs.id);
	if (result?.error) {
		console.error(`SMOKE FAIL: belief-former returned error: ${result.error}`);
		process.exit(2);
	}
	const ops = result?.ops ?? [];
	console.log(`  ops: ${JSON.stringify(ops.map((o) => ({ action: o.action, belief_id: o.belief_id?.slice(0, 8), claim: o.claim })))}`);
}

const beliefsAfter = await countBeliefs();
const edgesAfter = await countBeliefEntities();
console.log(`\nbeliefs after: ${beliefsAfter} (Δ${beliefsAfter - beliefsBefore})`);
console.log(`belief_entities after: ${edgesAfter} (Δ${edgesAfter - edgesBefore})`);

// Smoke passes if at least one belief was created AND linked to entities.
// (attach-only on a pre-existing belief would also be valid consolidation,
// but for a fresh smoke we require CREATE+LINK per the task.)
const created = beliefsAfter - beliefsBefore;
const linked = edgesAfter - edgesBefore;
if (created >= 1 && linked >= 1) {
	console.log(`\nSMOKE OK: created ${created} belief(s), ${linked} new entity edge(s)`);
	process.exit(0);
}
// If no CREATE but ops attached to existing beliefs, that's still functional.
console.error(`\nSMOKE WARN: created=${created} linked=${linked}; checking for any attach ops...`);
process.exit(created >= 1 && linked >= 1 ? 0 : 3);
