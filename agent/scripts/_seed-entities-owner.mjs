#!/usr/bin/env node
// Seed Green Oak's memory-graph ENTITY nodes for kind="owner".
//
// Loads the repo .env (Supabase + OPENAI_API_KEY for name embeddings), pulls
// distinct owner names from the legacy `owners` table for the Green Oak
// workspace, and calls resolveEntity (find-or-create, idempotent) for each.
//
// Usage: node agent/scripts/_seed-entities-owner.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(AGENT_ROOT, '..');

const WORKSPACE_ID = '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7';
const KIND = 'owner';

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

const { resolveEntity } = await import('../core/entities.mjs');
const { supabaseEnv } = await import('../core/supabase.mjs');

async function fetchOwnerNames() {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'name',
		workspace_id: `eq.${WORKSPACE_ID}`,
		order: 'name.asc',
		limit: '1000'
	});
	const res = await fetch(`${url}/rest/v1/owners?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`fetchOwnerNames: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	const seen = new Set();
	const names = [];
	for (const r of rows) {
		const nm = (r.name ?? '').trim();
		if (!nm || seen.has(nm)) continue;
		seen.add(nm);
		names.push(nm);
	}
	return names;
}

const names = await fetchOwnerNames();
console.log(`\nseed owner entities — workspace ${WORKSPACE_ID}`);
console.log(`distinct owner names: ${names.length}\n`);

let created = 0;
let found = 0;
const failures = [];
const resolvedNames = [];

for (const name of names) {
	try {
		const e = await resolveEntity({ workspace_id: WORKSPACE_ID, kind: KIND, name });
		if (e.created) created++;
		else found++;
		resolvedNames.push(e.name);
		const tag = e.created ? 'CREATED' : 'found  ';
		console.log(`  ${tag}  ${e.id.slice(0, 8)}  ref=${e.ref_table ?? 'null'}  ${name}`);
	} catch (err) {
		failures.push(name);
		console.log(`  ERROR    ${name} — ${err.message}`);
	}
}

const attempted = names.length;
const resolvedTotal = created + found;
const ok = failures.length === 0 && resolvedTotal === attempted;

const result = {
	kind: KIND,
	attempted,
	created,
	found,
	resolved_total: resolvedTotal,
	failures,
	sample: resolvedNames.slice(0, 5),
	ok
};

console.log('\n--- RESULT ---');
console.log(JSON.stringify(result, null, 2));

if (failures.length) process.exitCode = 1;
