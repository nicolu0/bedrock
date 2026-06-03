// Reusable AppFolio belief seeder. Builds a workspace's dispatch beliefs from
// its work-order observations, in two passes:
//
//   Phase 1 (LLM)          — the belief-former consolidates observations into
//                            vendor capability beliefs ("X handles Y") and
//                            accumulates each vendor's property footprint as
//                            entity edges. Fuzzy judgment lives here.
//   Phase 2 (deterministic)— counts vendor x property jobs and mints a
//                            property-scoped "go-to" belief for every real
//                            cluster (>= threshold). Counting lives here, where
//                            it can't be wrong. (Owner-scoped go-to activates
//                            automatically for workspaces that have owner
//                            entities + a property->owner map; AppFolio crawls
//                            without owner access stay property-scoped.)
//
// Idempotent: Phase 1 skips already-consolidated observations; Phase 2 skips
// clusters that already have a go-to belief.
//
//   node scripts/seed-appfolio-beliefs.mjs --workspace=greenoak
//   node scripts/seed-appfolio-beliefs.mjs --workspace=greenoak --goto-only
//   node scripts/seed-appfolio-beliefs.mjs --workspace=<uuid> --threshold=3

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = path.resolve(HERE, '../../.env');

for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (!m) continue;
	let v = m[2].trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
	process.env[m[1]] ??= v;
}

const arg = (name, def) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : def;
};
const has = (name) => process.argv.includes(`--${name}`);

const { WORKSPACES } = await import('../core/workspaces.mjs');
const memory = await import('../core/memory.mjs');
const entities = await import('../core/entities.mjs');
const { runBeliefFormer } = await import('../core/belief-former.mjs');
const { supabaseEnv } = await import('../core/supabase.mjs');
const { url, key } = supabaseEnv();
const sh = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' };
const get = (q) => fetch(`${url}/rest/v1/${q}`, { headers: sh }).then((r) => r.json());

// ── resolve workspace (label or uuid) ───────────────────────────────────────
const wsArg = arg('workspace');
if (!wsArg) { console.error('usage: --workspace=<label|uuid>'); process.exit(1); }
const isUuid = /^[0-9a-f-]{36}$/i.test(wsArg);
const WS = isUuid ? wsArg : Object.entries(WORKSPACES).find(([, w]) => w.label === wsArg)?.[0];
if (!WS) { console.error(`unknown workspace: ${wsArg}`); process.exit(1); }
const THRESHOLD = Number(arg('threshold', 3));
console.log(`seeding beliefs for workspace ${WS} (${WORKSPACES[WS]?.display ?? '?'}), go-to threshold=${THRESHOLD}\n`);

const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// ── Phase 1: LLM belief-former over unconsolidated observations ──────────────
if (!has('goto-only')) {
	const obs = await get(`observations?select=id,summary,ts&workspace_id=eq.${WS}&order=ts.asc&limit=1000`);
	const evRows = await get(`belief_evidence?select=observation_id,belief:beliefs!inner(workspace_id)&belief.workspace_id=eq.${WS}`);
	const done = new Set(evRows.map((r) => r.observation_id));
	const todo = obs.filter((o) => !done.has(o.id));
	console.log(`[phase 1 · LLM] ${obs.length} obs, ${done.size} consolidated, ${todo.length} to process`);
	let i = 0;
	for (const o of todo) {
		i++;
		try {
			const r = await runBeliefFormer(WS, o.id);
			const tag = (r.ops || []).map((op) => op.action[0].toUpperCase()).join('') || '-';
			console.log(`  [${i}/${todo.length}] ${tag.padEnd(3)} ${o.summary.slice(0, 56)}`);
		} catch (e) {
			console.log(`  [${i}/${todo.length}] ERR ${e.message}`);
		}
	}
}

if (has('llm-only')) { console.log('\n(llm-only — skipping go-to pass)'); process.exit(0); }

// ── Phase 2: deterministic property "go-to" pass ────────────────────────────
console.log(`\n[phase 2 · deterministic go-to]`);

// vendor + property entity per observation (positive-weight edges only).
const obsIds = (await get(`observations?select=id&workspace_id=eq.${WS}&limit=1000`)).map((o) => o.id);
const edges = [];
for (const ch of chunks(obsIds, 60)) {
	edges.push(...(await get(`observation_entities?select=observation_id,weight,entity:entities(id,kind,name)&observation_id=in.(${ch.join(',')})&weight=gt.0`)));
}
const byObs = new Map();
for (const r of edges) {
	if (!r.entity) continue;
	const o = byObs.get(r.observation_id) ?? {};
	if (r.entity.kind === 'vendor') o.vendor = r.entity;
	if (r.entity.kind === 'property') o.property = r.entity;
	byObs.set(r.observation_id, o);
}

// vendor x property clusters.
const clusters = new Map();
for (const [obsId, { vendor, property }] of byObs) {
	if (!vendor || !property) continue;
	const k = `${vendor.id}|${property.id}`;
	const c = clusters.get(k) ?? { vendor, property, obs: [] };
	c.obs.push(obsId);
	clusters.set(k, c);
}
const goto = [...clusters.values()].filter((c) => c.obs.length >= THRESHOLD);

// vendor -> trade, from the LLM capability beliefs (scope.trade).
const beliefRows = await get(`beliefs?select=id,scope,claim,belief_entities(entity_id)&workspace_id=eq.${WS}`);
const vendorTrade = new Map();
for (const b of beliefRows) {
	const trade = b.scope?.trade;
	if (!trade) continue;
	for (const be of b.belief_entities ?? []) if (!vendorTrade.has(be.entity_id)) vendorTrade.set(be.entity_id, trade);
}
// existing property-goto beliefs (idempotency): map "vendorId|propId".
const existingGoto = new Set();
for (const b of beliefRows) {
	if (b.scope?.kind !== 'property_goto') continue;
	const ents = (b.belief_entities ?? []).map((e) => e.entity_id);
	for (const a of ents) for (const z of ents) if (a !== z) existingGoto.add(`${a}|${z}`);
}

let created = 0, skipped = 0;
for (const c of goto.sort((a, b) => b.obs.length - a.obs.length)) {
	if (existingGoto.has(`${c.vendor.id}|${c.property.id}`)) { skipped++; continue; }
	const trade = vendorTrade.get(c.vendor.id) ?? null;
	const claim = `${c.vendor.name} is the go-to ${trade ? trade + ' ' : ''}vendor at ${c.property.name} (${c.obs.length} jobs).`;
	const confidence = Math.min(0.6, 0.3 + 0.05 * c.obs.length);
	const belief = await memory.createBelief(WS, {
		claim,
		scope: { kind: 'property_goto', trade, jobs: c.obs.length },
		confidence,
		explicitness: 'inferred',
		created_by: 'agent',
		tags: ['go-to', 'property-scoped']
	});
	await entities.attachEntityEdges(belief.id, [c.vendor.id, c.property.id]);
	for (const obsId of c.obs) await memory.attachEvidence(belief.id, obsId, 1.0).catch(() => {});
	created++;
	console.log(`  + ${claim}`);
}

console.log(`\nDONE go-to: ${created} created, ${skipped} already existed, from ${goto.length} clusters (>=${THRESHOLD} jobs).`);
const total = await get(`beliefs?select=id&workspace_id=eq.${WS}`);
console.log(`total beliefs in workspace: ${total.length}`);
