#!/usr/bin/env node
// Belief-former smoke — exercises the three scenarios from the memory-graph
// design doc (PR #1 success criteria):
//   (a) explicit high-salience statement → high-confidence belief created
//   (b) repeated low-salience corrections compound → confidence rises
//   (c) contradicting observation → confidence drops
//
// Hits real Supabase + OpenAI against the TEST workspace. NOT part of the
// orchestrator-skill eval suite (which mocks memory). Run when you've changed
// belief-former.mjs, memory.mjs, or any of the memory tools' run functions.
//
//   node agent/evals/belief-former-smoke.mjs
//   node agent/evals/belief-former-smoke.mjs --filter a
//
// Cost: ~$0.10–0.20 per full run (5 observations × belief-former turn).
//
// Cleans up after itself: deletes everything it wrote so reruns don't pile up.

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

// IMPORTANT: don't enable BEDROCK_EVAL_MODE here — we want real writes.
delete process.env.BEDROCK_EVAL_MODE;

const TEST_WS = '40d675ba-4dec-47dd-9222-79c0345c493f';

const memory = await import('../core/memory.mjs');
const { runBeliefFormer } = await import('../core/belief-former.mjs');

// ─── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const filterArg = (() => {
	const i = args.indexOf('--filter');
	return i >= 0 ? args[i + 1] : null;
})();

// ─── Reset test workspace memory state ─────────────────────────────────────

async function wipeTestWorkspace() {
	const { url, key } = (await import('../core/supabase.mjs')).supabaseEnv();
	const headers = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };
	// Order matters: belief_evidence cascades from beliefs/observations, but
	// deleting both parents explicitly is safer.
	await fetch(`${url}/rest/v1/beliefs?workspace_id=eq.${TEST_WS}`, { method: 'DELETE', headers });
	await fetch(`${url}/rest/v1/observations?workspace_id=eq.${TEST_WS}`, { method: 'DELETE', headers });
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

const scenarios = [
	{
		id: 'a',
		name: 'explicit high-salience statement → high-confidence belief created',
		async run() {
			await wipeTestWorkspace();
			const obs = await memory.addObservation(TEST_WS, {
				summary:
					'Jose said we always use Acme Plumbing for the Sunset Heights building — never anyone else.',
				salience: 0.95,
				entities: { trade: 'plumbing', property: 'Sunset Heights' },
				tags: ['vendor-preference', 'stated'],
				raw_text: 'we always use Acme Plumbing for sunset heights — never anyone else'
			});
			await runBeliefFormer(TEST_WS, obs.id);

			const beliefs = await memory.listBeliefs(TEST_WS);
			const created = beliefs.find(
				(b) => /acme/i.test(b.claim) && b.created_by === 'agent'
			);
			if (!created) return fail(`no agent-created belief about Acme found`, beliefs);
			if (created.confidence < 0.5) {
				return fail(
					`belief confidence ${created.confidence.toFixed(2)} is too low for a stated 0.95-salience signal`,
					created
				);
			}
			return pass(`belief "${created.claim.slice(0, 60)}…" created at confidence ${created.confidence.toFixed(2)}`);
		}
	},

	{
		id: 'b',
		name: 'repeated low-salience observations compound → confidence rises',
		async run() {
			await wipeTestWorkspace();
			// First observation creates the belief at moderate confidence.
			const obs1 = await memory.addObservation(TEST_WS, {
				summary: 'Jose dispatched RapidFix for a leak at Maple Court.',
				salience: 0.4,
				entities: { trade: 'plumbing', vendor: 'RapidFix', property: 'Maple Court' },
				tags: ['observed-dispatch']
			});
			await runBeliefFormer(TEST_WS, obs1.id);

			const before = await memory.listBeliefs(TEST_WS);
			const initial = before.find((b) => /rapidfix/i.test(b.claim));
			if (!initial) return fail('first observation did not produce a belief', before);
			const c1 = initial.confidence;

			// Two more low-salience confirmations.
			for (let i = 0; i < 2; i++) {
				const obs = await memory.addObservation(TEST_WS, {
					summary: `Jose dispatched RapidFix again for a plumbing issue at Maple Court.`,
					salience: 0.4,
					entities: { trade: 'plumbing', vendor: 'RapidFix', property: 'Maple Court' },
					tags: ['observed-dispatch']
				});
				await runBeliefFormer(TEST_WS, obs.id);
			}

			const after = await memory.listBeliefs(TEST_WS);
			const final = after.find((b) => b.id === initial.id);
			if (!final) return fail('belief disappeared after compounding observations', after);
			if (final.confidence <= c1) {
				return fail(
					`confidence did not rise: ${c1.toFixed(2)} → ${final.confidence.toFixed(2)}`,
					{ initial, final }
				);
			}
			return pass(
				`confidence compounded ${c1.toFixed(2)} → ${final.confidence.toFixed(2)} over 3 low-salience observations`
			);
		}
	},

	{
		id: 'c',
		name: 'contradicting observation → confidence drops',
		async run() {
			await wipeTestWorkspace();
			// Seed a belief manually at high confidence.
			const seeded = await memory.createBelief(TEST_WS, {
				claim: 'Use Yonic for plumbing issues.',
				scope: { trade: 'plumbing' },
				confidence: 0.85,
				explicitness: 'stated',
				created_by: 'user',
				tags: ['vendor-preference']
			});
			const c0 = seeded.confidence;

			// Contradiction: Jose dispatches someone else for the same trade.
			const obs = await memory.addObservation(TEST_WS, {
				summary:
					'Jose told us NOT to send Yonic anymore for plumbing — switching to Cory Plumbing going forward.',
				salience: 0.9,
				entities: { trade: 'plumbing' },
				tags: ['correction', 'vendor-change'],
				raw_text: "don't send yonic anymore for plumbing, we're using cory plumbing now"
			});
			await runBeliefFormer(TEST_WS, obs.id);

			const after = await memory.listBeliefs(TEST_WS);
			const updated = after.find((b) => b.id === seeded.id);
			if (!updated) return fail('seeded belief disappeared', after);
			if (updated.confidence >= c0) {
				return fail(
					`confidence did not drop: ${c0.toFixed(2)} → ${updated.confidence.toFixed(2)}; expected the contradiction to penalize the belief`,
					{ before: seeded, after: updated }
				);
			}
			return pass(
				`confidence dropped ${c0.toFixed(2)} → ${updated.confidence.toFixed(2)} after explicit contradiction`
			);
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

const selected = filterArg ? scenarios.filter((s) => s.id === filterArg || s.name.includes(filterArg)) : scenarios;
if (!selected.length) {
	console.error(`no scenarios match filter "${filterArg}"`);
	process.exit(2);
}

let passN = 0;
let failN = 0;
const t0 = Date.now();

for (const sc of selected) {
	process.stdout.write(`▷ ${sc.id}: ${sc.name} ... `);
	try {
		const r = await sc.run();
		if (r.ok) {
			console.log(`✓ ${r.msg}`);
			passN++;
		} else {
			console.log(`✗`);
			console.log(`    · ${r.msg}`);
			if (r.detail) console.log(`    · detail:`, JSON.stringify(r.detail, null, 2).slice(0, 500));
			failN++;
		}
	} catch (err) {
		console.log(`✗ exception`);
		console.log(`    · ${err.message}`);
		console.log(`    · ${err.stack?.split('\n').slice(0, 4).join('\n      ')}`);
		failN++;
	}
}

// Final cleanup so we don't leave state behind.
await wipeTestWorkspace();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n━━━ ${passN}/${selected.length} pass · ${elapsed}s ━━━`);
process.exit(failN > 0 ? 1 : 0);
