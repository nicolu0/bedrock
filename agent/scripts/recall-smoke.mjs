#!/usr/bin/env node
// Smoke test for the recall tool. Runs each of the 3 hybrid tiers against
// the prod workspace and prints what came back so we can eyeball quality.

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

const { recall } = await import('../tools/recall.mjs');

const ws = '2e4373a0-40b8-42c2-a873-b08c99dbf76a';
const ctx = { workspace_id: ws };

async function run(label, args) {
	console.log(`\n══ ${label}`);
	console.log(`  args: ${JSON.stringify(args)}`);
	const out = await recall.run(args, ctx);
	console.log(
		`  resolved: ${out.resolved_entities.map((e) => `${e.kind}:${e.name}`).join(', ') || '(none)'}`
	);
	console.log(`  fallback: ${out.fallback_reason ?? '(none)'}`);
	console.log(`  candidates (${out.candidates.length}):`);
	for (const c of out.candidates.slice(0, 5)) {
		const summary =
			c.kind === 'belief'
				? c.data.claim.slice(0, 80)
				: c.kind === 'observation'
					? c.data.summary?.slice(0, 80)
					: c.data.name;
		console.log(`   [${c.via}/${c.kind} ${c.score.toFixed(2)}] ${summary}`);
		console.log(`       ${c.provenance.slice(0, 140)}`);
	}
}

await run('case 1 — entity-anchored hit (plumbing at Ozone)', {
	question: 'who do we use for plumbing at 15 Ozone Ave?',
	property: '15 Ozone Ave',
	issue: 'shower drain slow'
});

await run('case 2 — vendor history lookup', {
	question: 'have we used Yonic before?',
	vendor: 'Yonic'
});

await run('case 3 — general semantic recall (no hints)', {
	question: 'who do we use for handyman work'
});

await run('case 4 — legacy fallback for unknown property + HVAC', {
	question: 'who handles HVAC at 9999 Imaginary Lane?',
	property: '9999 Imaginary Lane',
	issue: 'AC not blowing cold'
});

console.log('\nall cases executed.');
