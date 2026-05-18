#!/usr/bin/env node
// vendor-agent smoke — exercises the live edge function against the TEST
// workspace with controlled fixtures (vendors, properties, beliefs, issues).
// Verifies PR #2: beliefs influence vendor selection.
//
//   node agent/evals/vendor-agent-smoke.mjs
//   node agent/evals/vendor-agent-smoke.mjs --filter b
//
// Cost: ~3 edge invocations × (1 embed + 1 chat) ≈ $0.01–0.03 per full run.
//
// Self-cleaning: every row we create is tagged or prefixed "SMOKE_" and torn
// down at the end. Other test-workspace state (beliefs you wrote by hand, real
// issues) is left alone.

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
	} catch {}
}
await loadDotEnv(path.join(REPO_ROOT, '.env'));
await loadDotEnv(path.join(AGENT_ROOT, '.env'));

if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.OPENAI_API_KEY) {
	console.error('env not loaded — symlink .env from main repo first');
	process.exit(2);
}

// Dedicated isolated workspace for smoke tests. Pre-seeded in Supabase. We
// own everything in it — wipe freely on entry and exit. Andrew's Workspace
// (the user-facing TEST workspace) is left untouched.
const SMOKE_WS = '00000000-0000-4000-a000-00000000beef';
const SMOKE_TAG = 'smoke-vendor-agent';
const SMOKE_PREFIX = 'SMOKE_';

const memory = await import('../core/memory.mjs');
const { supabaseEnv } = await import('../supabase.mjs');
const { url: SUPABASE_URL, key: SR_KEY } = supabaseEnv();

// ─── Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filterArg = (() => {
	const i = args.indexOf('--filter');
	return i >= 0 ? args[i + 1] : null;
})();

// ─── REST helpers ──────────────────────────────────────────────────────────

const HDR = { apikey: SR_KEY, Authorization: `Bearer ${SR_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };

async function rpost(table, rows, returnRep = true) {
	const headers = { ...HDR };
	if (returnRep) headers.Prefer = 'return=representation';
	const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(rows)
	});
	if (!res.ok) throw new Error(`insert ${table}: ${res.status} ${await res.text()}`);
	return returnRep ? res.json() : null;
}

async function rdel(table, filter) {
	const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
		method: 'DELETE',
		headers: HDR
	});
	if (!res.ok && res.status !== 404) {
		console.warn(`delete ${table} (${filter}): ${res.status} ${await res.text()}`);
	}
}

async function rget(table, query) {
	const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: HDR });
	if (!res.ok) throw new Error(`get ${table}: ${res.status} ${await res.text()}`);
	return res.json();
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

async function wipeSmokeArtifacts() {
	// The smoke workspace is dedicated to us — wipe everything. Order matters
	// for FKs: agent_runs → issues → properties/vendors; belief_evidence
	// cascades from beliefs/observations.
	const issues = await rget('issues_v2', `select=id&workspace_id=eq.${SMOKE_WS}`);
	const issueIds = issues.map((r) => r.id);
	if (issueIds.length) {
		await rdel('agent_runs', `issue_id=in.(${issueIds.join(',')})`);
		await rdel('issues_v2', `id=in.(${issueIds.join(',')})`);
	}
	await rdel('vendors', `workspace_id=eq.${SMOKE_WS}`);
	await rdel('properties', `workspace_id=eq.${SMOKE_WS}`);
	await rdel('beliefs', `workspace_id=eq.${SMOKE_WS}`);
	await rdel('observations', `workspace_id=eq.${SMOKE_WS}`);
}

// ─── Fixture setup ─────────────────────────────────────────────────────────

async function setupFixtures() {
	// 3 vendors with clear trade signal so the model has a real choice.
	const vendors = await rpost('vendors', [
		{ workspace_id: SMOKE_WS, name: `${SMOKE_PREFIX}Yonic Plumbing`, trade: 'plumber', preference_index: 1 },
		{ workspace_id: SMOKE_WS, name: `${SMOKE_PREFIX}Cory Plumbing`, trade: 'plumber', preference_index: 2 },
		{ workspace_id: SMOKE_WS, name: `${SMOKE_PREFIX}Abraham Handyman`, trade: 'handyman', preference_index: 3 }
	]);
	const property = (
		await rpost('properties', [{ workspace_id: SMOKE_WS, name: `${SMOKE_PREFIX}Hub Champaign` }])
	)[0];
	const byName = (n) => vendors.find((v) => v.name === `${SMOKE_PREFIX}${n}`);
	return {
		vendors,
		property,
		yonic: byName('Yonic Plumbing'),
		cory: byName('Cory Plumbing'),
		abraham: byName('Abraham Handyman')
	};
}

async function createIssue({ workspace_id, property_id, description }) {
	const [issue] = await rpost('issues_v2', [{ workspace_id, property_id, description, urgent: false }]);
	// vendor-agent expects an agent_run row to claim. Pre-insert as pending.
	await rpost(
		'agent_runs',
		[{ issue_id: issue.id, agent_name: 'vendor', status: 'pending', attempt_count: 0 }],
		false
	);
	return issue;
}

async function invokeVendorAgent(issueId) {
	const res = await fetch(`${SUPABASE_URL}/functions/v1/vendor-agent`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: SR_KEY,
			Authorization: `Bearer ${SR_KEY}`
		},
		body: JSON.stringify({ issueId })
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`vendor-agent ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
	return body;
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

const scenarios = [
	{
		id: 'a',
		name: 'stated high-confidence belief → that vendor picked',
		async run(fx) {
			// Belief says use Cory at this property — Cory is NOT the
			// preference_index=1 default (that's Yonic). If the model picked Yonic
			// it ignored the belief.
			await memory.createBelief(SMOKE_WS, {
				claim: 'For plumbing issues at Hub Champaign, always use Cory Plumbing.',
				scope: { property_id: fx.property.id, trade: 'plumbing' },
				confidence: 0.92,
				explicitness: 'stated',
				created_by: 'user',
				tags: [SMOKE_TAG, 'vendor-preference']
			});

			const issue = await createIssue({
				workspace_id: SMOKE_WS,
				property_id: fx.property.id,
				description: `${SMOKE_PREFIX}kitchen sink is leaking under the cabinet`
			});
			const result = await invokeVendorAgent(issue.id);

			if (result.vendorId !== fx.cory.id) {
				return fail(
					`expected Cory (${fx.cory.id.slice(0, 8)}) but got ${result.vendorId?.slice(0, 8)} — reason: "${result.reason}"`,
					result
				);
			}
			return pass(`Cory picked (reason: "${result.reason}")`);
		}
	},

	{
		id: 'b',
		name: 'property-scoped belief overrides general belief',
		async run(fx) {
			// Default belief: Yonic for plumbing (no property scope).
			// Property-specific belief: Cory for plumbing at this property.
			// The agent should weight the property-scoped one higher.
			await memory.createBelief(SMOKE_WS, {
				claim: 'For general plumbing issues, use Yonic Plumbing.',
				scope: { trade: 'plumbing' },
				confidence: 0.9,
				explicitness: 'stated',
				created_by: 'user',
				tags: [SMOKE_TAG, 'vendor-preference']
			});
			await memory.createBelief(SMOKE_WS, {
				claim: 'For plumbing issues at Hub Champaign specifically, use Cory Plumbing instead of Yonic.',
				scope: { property_id: fx.property.id, trade: 'plumbing' },
				confidence: 0.92,
				explicitness: 'stated',
				created_by: 'user',
				tags: [SMOKE_TAG, 'vendor-preference']
			});

			const issue = await createIssue({
				workspace_id: SMOKE_WS,
				property_id: fx.property.id,
				description: `${SMOKE_PREFIX}toilet running constantly`
			});
			const result = await invokeVendorAgent(issue.id);

			if (result.vendorId !== fx.cory.id) {
				return fail(
					`expected Cory (property-scoped) but got ${result.vendorId?.slice(0, 8)} — reason: "${result.reason}"`,
					result
				);
			}
			return pass(`property-scoped belief honored over general (reason: "${result.reason}")`);
		}
	},

	{
		id: 'c',
		name: 'no relevant belief → reasonable fallback (trade-matched vendor)',
		async run(fx) {
			// Only an UNRELATED belief — about handyman work, not plumbing.
			await memory.createBelief(SMOKE_WS, {
				claim: 'For handyman work at unrelated property, use Abraham.',
				scope: { trade: 'handyman' },
				confidence: 0.85,
				explicitness: 'stated',
				created_by: 'user',
				tags: [SMOKE_TAG]
			});

			const issue = await createIssue({
				workspace_id: SMOKE_WS,
				property_id: fx.property.id,
				description: `${SMOKE_PREFIX}bathroom sink drain is completely clogged, water won't go down`
			});
			const result = await invokeVendorAgent(issue.id);

			// Either plumber is fine — Yonic or Cory. Abraham (handyman) is wrong.
			if (result.vendorId === fx.abraham.id) {
				return fail(
					`picked Abraham (handyman) for a plumbing issue — irrelevant belief leaked through?`,
					result
				);
			}
			if (result.vendorId !== fx.yonic.id && result.vendorId !== fx.cory.id) {
				return fail(`picked unknown vendor ${result.vendorId}`, result);
			}
			return pass(`fallback picked a plumber (${result.vendorId === fx.yonic.id ? 'Yonic' : 'Cory'})`);
		}
	}
];

// ─── Runner ────────────────────────────────────────────────────────────────

function pass(msg) {
	return { ok: true, msg };
}
function fail(msg, detail) {
	return { ok: false, msg, detail };
}

const selected = filterArg
	? scenarios.filter((s) => s.id === filterArg || s.name.toLowerCase().includes(filterArg.toLowerCase()))
	: scenarios;
if (!selected.length) {
	console.error(`no scenarios match filter "${filterArg}"`);
	process.exit(2);
}

console.log(`vendor-agent smoke (workspace ${SMOKE_WS.slice(0, 8)})\n`);

await wipeSmokeArtifacts();
let passN = 0;
let failN = 0;
const t0 = Date.now();

try {
	for (const sc of selected) {
		// Fresh fixtures per scenario so beliefs don't leak between cases.
		await wipeSmokeArtifacts();
		const fx = await setupFixtures();
		process.stdout.write(`▷ ${sc.id}: ${sc.name} ... `);
		try {
			const r = await sc.run(fx);
			if (r.ok) {
				console.log(`✓ ${r.msg}`);
				passN++;
			} else {
				console.log(`✗`);
				console.log(`    · ${r.msg}`);
				if (r.detail) console.log(`    · detail:`, JSON.stringify(r.detail, null, 2).slice(0, 400));
				failN++;
			}
		} catch (err) {
			console.log(`✗ exception`);
			console.log(`    · ${err.message}`);
			failN++;
		}
	}
} finally {
	await wipeSmokeArtifacts();
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n━━━ ${passN}/${selected.length} pass · ${elapsed}s ━━━`);
process.exit(failN > 0 ? 1 : 0);
