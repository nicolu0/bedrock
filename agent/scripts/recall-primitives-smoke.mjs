#!/usr/bin/env node
// Smoke test for the new PR5 query primitives. Verifies join walks and
// legacy fallbacks return shape-correct data against the prod workspace.

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

const {
	beliefsForEntities,
	observationsForEntities,
	legacyVendorsForTrade,
	legacyOwnerForProperty
} = await import('../core/memory.mjs');
const { listEntities, resolveEntity, cascadeOwners } = await import('../core/entities.mjs');

const ws = '2e4373a0-40b8-42c2-a873-b08c99dbf76a';

console.log('=== recall primitives smoke ===');

// Pick a property entity that we know has a cascade (Ozone Ave -> Harrison)
const ents = await listEntities(ws, { limit: 500 });
const ozone = ents.find((e) => e.kind === 'property' && /ozone/i.test(e.name));
const propEnt = ozone ?? ents.find((e) => e.kind === 'property' && e.ref_id);
if (!propEnt) {
	console.error('no property entity available for test');
	process.exit(1);
}
console.log(`property: ${propEnt.name} (${propEnt.id.slice(0, 8)}…, ref_id=${propEnt.ref_id})`);

const owners = await cascadeOwners(propEnt, ws);
console.log(`cascadeOwners: ${owners.length} owner(s):`);
for (const o of owners) console.log(`  - ${o.name} (${o.id.slice(0, 8)}…)`);

const anchorIds = [propEnt.id, ...owners.map((o) => o.id)];

console.log('\n— beliefsForEntities —');
const beliefs = await beliefsForEntities(ws, anchorIds, { limit: 20 });
console.log(`returned ${beliefs.length} beliefs`);
for (const b of beliefs.slice(0, 5)) {
	console.log(
		`  · ${b.claim.slice(0, 80)} | conf=${b.confidence} ev=${b.evidence_count} matched=${b.matched_entity_ids.length}`
	);
}

console.log('\n— observationsForEntities —');
const obs = await observationsForEntities(ws, anchorIds, { limit: 20 });
console.log(`returned ${obs.length} observations`);
for (const o of obs.slice(0, 5)) {
	console.log(
		`  · ${(o.summary || '').slice(0, 80)} | w=${o.weight} matched=${o.matched_entity_ids.length}`
	);
}

console.log('\n— legacyVendorsForTrade(plumbing) —');
const vs = await legacyVendorsForTrade(ws, 'plumb');
console.log(`returned ${vs.length} vendors`);
for (const v of vs.slice(0, 5)) console.log(`  · ${v.name} [trade=${v.trade}]`);

console.log('\n— legacyOwnerForProperty —');
const lo = await legacyOwnerForProperty(ws, propEnt.ref_id);
console.log(`returned ${lo.length} owner(s)`);
for (const o of lo) console.log(`  · ${o.name}`);

console.log('\nall primitives executed without error.');
