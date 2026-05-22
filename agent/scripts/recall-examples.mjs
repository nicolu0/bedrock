#!/usr/bin/env node
// Quick demo: call the recall tool directly with various example queries,
// print the args and full ranked output. No LLM, no chat skill — just the
// hybrid retrieval against the prod memory graph.

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

const examples = [
	{
		title: "PM asks: who do we use for a broken garbage disposal?",
		args: {
			question: 'who do we use for garbage disposals',
			issue: 'broken garbage disposal'
		}
	},
	{
		title: 'PM asks: who should I send for HVAC at 6337 Primrose?',
		args: {
			question: 'best vendor for HVAC at 6337 Primrose',
			property: '6337 Primrose',
			issue: 'air conditioning'
		}
	},
	{
		title: "PM asks: have we used Abraham before?",
		args: {
			question: 'history with Abraham',
			vendor: 'Abraham'
		}
	},
	{
		title: 'PM asks: what do we know about Kori Anderson?',
		args: {
			question: 'vendor history for Kori',
			vendor: 'Kori Anderson'
		}
	},
	{
		title: 'PM mentions a brand-new property + electrical issue (no memory yet)',
		args: {
			question: 'electrician for unknown property',
			property: '9999 Pretend Lane',
			issue: 'outlet not working in bedroom'
		}
	}
];

for (const [i, ex] of examples.entries()) {
	console.log(`\n${'═'.repeat(70)}`);
	console.log(`EXAMPLE ${i + 1}: ${ex.title}`);
	console.log('─'.repeat(70));
	console.log(`call: recall(${JSON.stringify(ex.args, null, 2).replace(/\n/g, '\n      ')})`);

	const out = await recall.run(ex.args, ctx);

	console.log('');
	console.log(
		`resolved entities: ${
			out.resolved_entities.map((e) => `${e.kind}:${e.name}`).join(', ') || '(none)'
		}`
	);
	console.log(`tiers fired     : ${out.tiers_fired.join(', ') || '(none)'}`);
	console.log(`candidates returned: ${out.candidates.length}`);

	for (const [j, c] of out.candidates.entries()) {
		const summary =
			c.kind === 'belief'
				? c.data.claim
				: c.kind === 'observation'
					? c.data.summary
					: c.data.name;
		console.log('');
		console.log(
			`  ${j + 1}. [${c.via}/${c.kind}] score=${c.score.toFixed(2)} conf=${c.confidence.toFixed(2)}`
		);
		console.log(`     ${summary}`);
		console.log(`     ↪ ${c.provenance}`);
	}
}

console.log(`\n${'═'.repeat(70)}\nall ${examples.length} examples done.`);
