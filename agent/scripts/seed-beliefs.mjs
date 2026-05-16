#!/usr/bin/env node
// Seed the manual beliefs from agent/data/seed-beliefs.json into a workspace.
// Computes embeddings client-side via OpenAI so the rows are vector-searchable
// immediately (the agent / belief-former rely on this).
//
// Usage:
//   node agent/scripts/seed-beliefs.mjs --workspace=<id|prod|test> [--clear]
//
// --clear deletes existing created_by='user' beliefs in the workspace first
// so reruns are idempotent. Agent-created beliefs and their evidence are
// untouched.
//
// Env required: PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
// OPENAI_API_KEY. Resolved from the current shell first, then .env files at the
// repo root and agent/ (in that order).

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

// .env loading: shell first, then repo-root, then agent/. Also try the main
// (non-worktree) checkout's .env in case we're running from a worktree.
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

const wsArg = arg('workspace');
if (!wsArg) {
	console.error('usage: node agent/scripts/seed-beliefs.mjs --workspace=<id|prod|test> [--clear]');
	process.exit(2);
}
const clearFirst = arg('clear') === true;

// Map prod|test → uuid via WORKSPACES (no need to import — keep this script
// portable in case the workspace mapping changes).
const WORKSPACE_LABELS = {
	prod: '2e4373a0-40b8-42c2-a873-b08c99dbf76a',
	test: '40d675ba-4dec-47dd-9222-79c0345c493f'
};
const workspace_id = WORKSPACE_LABELS[wsArg] ?? wsArg;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspace_id)) {
	console.error(`bad workspace: ${wsArg} (not a uuid and not a known label)`);
	process.exit(2);
}

// Bail early if env is missing rather than failing mid-loop.
for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) {
	if (!process.env[k]) {
		console.error(`env ${k} not set; source the repo .env first`);
		process.exit(2);
	}
}
if (!process.env.PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) {
	console.error('env PUBLIC_SUPABASE_URL or SUPABASE_URL not set');
	process.exit(2);
}

// Late import so the memory module sees the loaded env.
const memory = await import('../core/memory.mjs');

const seedsPath = path.join(AGENT_ROOT, 'data', 'seed-beliefs.json');
const seeds = JSON.parse(await fs.readFile(seedsPath, 'utf8'));
console.log(`loaded ${seeds.length} seeds from ${seedsPath}`);
console.log(`workspace: ${wsArg} → ${workspace_id}`);

if (clearFirst) {
	const existing = await memory.listBeliefs(workspace_id, { limit: 500 });
	const userBeliefs = existing.filter((b) => b.created_by === 'user');
	console.log(`clearing ${userBeliefs.length} existing user beliefs first`);
	for (const b of userBeliefs) {
		await memory.deleteBelief(b.id);
	}
}

let n = 0;
for (const seed of seeds) {
	const belief = await memory.createBelief(workspace_id, {
		claim: seed.claim,
		scope: seed.scope ?? {},
		confidence: seed.confidence ?? 0.85,
		explicitness: seed.explicitness ?? 'stated',
		created_by: 'user',
		tags: seed.tags ?? []
	});
	console.log(`  [+] ${belief.id.slice(0, 8)}  conf=${belief.confidence.toFixed(2)}  ${belief.claim.slice(0, 70)}`);
	n++;
}
console.log(`done — ${n} beliefs inserted`);
