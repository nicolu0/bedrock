#!/usr/bin/env node
// Smoke test for entity resolution. Verifies the 3-step lookup:
//   - "Mario" (vendor) → promotes from legacy vendors table if present, else creates informal.
//   - "Mario " (trailing space) → resolves to same id (name normalization).
//   - "MARIO" (caps) → also resolves to same id (case-insensitive legacy match).
//   - "Harrison Properties" (owner, no legacy row) → creates informal entity with ref_table=null.
//   - Second call for "Harrison Properties" → returns the same id.
//
// Usage: node agent/scripts/entity-smoke.mjs --workspace=test [--cleanup]

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
const wsArg = arg('workspace') || 'test';
const workspace_id = WORKSPACE_LABELS[wsArg] ?? wsArg;
const cleanup = arg('cleanup') === true;

const { resolveEntity, listEntities } = await import('../core/entities.mjs');
const { supabaseEnv } = await import('../supabase.mjs');

let passed = 0;
let failed = 0;
function assert(label, cond, detail = '') {
	if (cond) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

console.log(`\nentity smoke — workspace ${wsArg} (${workspace_id})\n`);

// Case A: a vendor name. Whether or not it's in the legacy vendors table,
// the second resolution should return the same id.
console.log('Case A: vendor "Mario" (find-or-create)');
const a1 = await resolveEntity({ workspace_id, kind: 'vendor', name: 'Mario' });
console.log(`    a1: id=${a1.id.slice(0, 8)} ref_table=${a1.ref_table ?? 'null'} created=${a1.created}`);
const a2 = await resolveEntity({ workspace_id, kind: 'vendor', name: 'Mario' });
console.log(`    a2: id=${a2.id.slice(0, 8)} ref_table=${a2.ref_table ?? 'null'} created=${a2.created}`);
assert('second Mario resolves to same id', a1.id === a2.id, `${a1.id} vs ${a2.id}`);
assert('second Mario is created=false', !a2.created);

// Case B: trailing space — should normalize and resolve to same id.
console.log('\nCase B: vendor "Mario " (with trailing space)');
const b = await resolveEntity({ workspace_id, kind: 'vendor', name: 'Mario ' });
console.log(`    b:  id=${b.id.slice(0, 8)} created=${b.created}`);
assert('Mario+space resolves to same id', a1.id === b.id);

// Case C: an unmistakably-informal owner ("Harrison Properties").
console.log('\nCase C: owner "Harrison Properties" (likely no legacy row)');
const c1 = await resolveEntity({ workspace_id, kind: 'owner', name: 'Harrison Properties' });
console.log(`    c1: id=${c1.id.slice(0, 8)} ref_table=${c1.ref_table ?? 'null'} created=${c1.created}`);
const c2 = await resolveEntity({ workspace_id, kind: 'owner', name: 'Harrison Properties' });
console.log(`    c2: id=${c2.id.slice(0, 8)} created=${c2.created}`);
assert('Harrison Properties second call is same id', c1.id === c2.id);
assert('Harrison Properties second call is created=false', !c2.created);

// Case D: vector match — slight name variant should fold into the same row.
console.log('\nCase D: owner "Harrison properties" (lowercase variant — vector match)');
const d = await resolveEntity({ workspace_id, kind: 'owner', name: 'Harrison properties' });
console.log(`    d:  id=${d.id.slice(0, 8)} created=${d.created}`);
assert('lowercase variant folds into same id', c1.id === d.id, `${c1.id} vs ${d.id}`);

// Summary
console.log(`\n${passed} passed, ${failed} failed`);

if (cleanup) {
	console.log('\n--cleanup: removing test entities…');
	const { url, key } = supabaseEnv();
	const ids = [a1.id, c1.id, d.id].filter((id, i, arr) => arr.indexOf(id) === i);
	for (const id of ids) {
		await fetch(`${url}/rest/v1/entities?id=eq.${id}`, {
			method: 'DELETE',
			headers: { apikey: key, Authorization: `Bearer ${key}` }
		});
	}
	console.log(`  removed ${ids.length} entities`);
}

if (failed > 0) process.exit(1);
