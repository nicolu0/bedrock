#!/usr/bin/env node
// Seed Green Oak's memory-graph ENTITY nodes for kind="property".
//
// Loads the repo .env (Supabase + OPENAI_API_KEY for name embeddings), pulls
// the distinct property names from the legacy `properties` table for the
// Green Oak workspace, and calls resolveEntity({ workspace_id, kind:'property',
// name }) for each. resolveEntity is find-or-create + idempotent, so re-running
// is safe. Does NOT call cascadeOwners or touch owners.
//
// Usage: node agent/scripts/_seed-entities-property.mjs

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

const WORKSPACE_ID = '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7';

const { resolveEntity } = await import('../core/entities.mjs');
const { supabaseEnv } = await import('../core/supabase.mjs');

// Pull distinct property names from the legacy properties table.
async function fetchPropertyNames() {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'name',
		workspace_id: `eq.${WORKSPACE_ID}`,
		limit: '1000'
	});
	const res = await fetch(`${url}/rest/v1/properties?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`fetchPropertyNames: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	const names = rows.map((r) => (r.name == null ? '' : String(r.name).trim())).filter(Boolean);
	return [...new Set(names)];
}

const names = await fetchPropertyNames();
console.log(`\nseed property entities — workspace ${WORKSPACE_ID}`);
console.log(`distinct property names: ${names.length}\n`);

let created = 0;
let found = 0;
const failures = [];
const resolvedNames = [];

for (const name of names) {
	try {
		const ent = await resolveEntity({ workspace_id: WORKSPACE_ID, kind: 'property', name });
		if (ent.created) created++;
		else found++;
		resolvedNames.push(ent.name);
		console.log(
			`  ${ent.created ? '+ created' : '= found  '}  ${name}` +
				(ent.name !== name ? `  → ${ent.name}` : '') +
				`  [ref_table=${ent.ref_table ?? 'null'}]`
		);
	} catch (err) {
		failures.push(name);
		console.log(`  ✗ ERROR    ${name} — ${err.message}`);
	}
}

const attempted = names.length;
const summary = {
	kind: 'property',
	attempted,
	created,
	found,
	failures,
	sample: resolvedNames.slice(0, 5)
};

console.log(`\n${'─'.repeat(50)}`);
console.log(`attempted=${attempted}  created=${created}  found=${found}  failures=${failures.length}`);
console.log(`SUMMARY_JSON ${JSON.stringify(summary)}`);
