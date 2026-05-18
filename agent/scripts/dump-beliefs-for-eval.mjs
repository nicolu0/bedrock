#!/usr/bin/env node
// Build a side-by-side HTML for the belief-eval walkthrough:
// gold beliefs (from beliefs.gold.json) on the LEFT, actual beliefs
// (from DB) on the RIGHT, plus an "extras" section for actual beliefs
// that don't map to any gold (potential over-creates).
//
// Output: agent/evals/memory-graph/belief-review.html

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

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error('Need PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
	process.exit(1);
}
const WORKSPACE = '2e4373a0-40b8-42c2-a873-b08c99dbf76a';

function headers() {
	return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' };
}

async function fetchAll(p) {
	const res = await fetch(`${SUPABASE_URL}${p}`, { headers: headers() });
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json();
}

console.log('Fetching beliefs + entity links + evidence…');

const beliefs = await fetchAll(
	`/rest/v1/beliefs?select=id,claim,scope,confidence,explicitness,created_by,created_at,tags,status&workspace_id=eq.${WORKSPACE}&order=created_at.asc&limit=500`
);
const beliefEntities = await fetchAll(
	`/rest/v1/belief_entities?select=belief_id,entity_id,belief:beliefs!inner(workspace_id)&belief.workspace_id=eq.${WORKSPACE}`
);
const beliefEvidence = await fetchAll(
	`/rest/v1/belief_evidence?select=belief_id,observation_id,weight,belief:beliefs!inner(workspace_id)&belief.workspace_id=eq.${WORKSPACE}`
);
const entities = await fetchAll(
	`/rest/v1/entities?select=id,kind,name&workspace_id=eq.${WORKSPACE}&limit=500`
);
const observations = await fetchAll(
	`/rest/v1/observations?select=id,title,summary&workspace_id=eq.${WORKSPACE}&limit=500`
);

const entityById = new Map(entities.map((e) => [e.id, e]));
const obsById = new Map(observations.map((o) => [o.id, o]));

const entsByBelief = new Map();
for (const be of beliefEntities) {
	const e = entityById.get(be.entity_id);
	if (!e) continue;
	if (!entsByBelief.has(be.belief_id)) entsByBelief.set(be.belief_id, []);
	entsByBelief.get(be.belief_id).push(e);
}
const evByBelief = new Map();
for (const be of beliefEvidence) {
	const o = obsById.get(be.observation_id);
	if (!o) continue;
	if (!evByBelief.has(be.belief_id)) evByBelief.set(be.belief_id, []);
	evByBelief.get(be.belief_id).push({ ...o, weight: be.weight });
}

for (const b of beliefs) {
	b.entities = entsByBelief.get(b.id) || [];
	b.evidence = evByBelief.get(b.id) || [];
}

// Load gold
const goldPath = path.join(AGENT_ROOT, 'evals', 'memory-graph', 'beliefs.gold.json');
const gold = JSON.parse(await fs.readFile(goldPath, 'utf8'));

// Heuristic pairing: for each gold belief, find the best-matching actual belief
// by entity-set overlap. Simple greedy match.
function entityKey(ents) {
	return ents
		.map((e) => `${e.kind}:${(e.name || '').toLowerCase()}`)
		.sort()
		.join('|');
}
function jaccardEntityScore(goldEnts, actualEnts) {
	const gKeys = new Set(goldEnts.map((e) => `${e.kind}:${(e.name || '').toLowerCase()}`));
	const aKeys = new Set(actualEnts.map((e) => `${e.kind}:${(e.name || '').toLowerCase()}`));
	if (gKeys.size === 0 || aKeys.size === 0) return 0;
	let inter = 0;
	for (const k of gKeys) if (aKeys.has(k)) inter++;
	const union = gKeys.size + aKeys.size - inter;
	return union > 0 ? inter / union : 0;
}

const usedActual = new Set();
const pairs = []; // [{ gold, actual|null, score }]
for (const g of gold.beliefs) {
	let best = null;
	let bestScore = 0;
	for (const a of beliefs) {
		if (usedActual.has(a.id)) continue;
		const s = jaccardEntityScore(g.scope_entities || [], a.entities);
		if (s > bestScore) {
			best = a;
			bestScore = s;
		}
	}
	if (best && bestScore > 0) usedActual.add(best.id);
	pairs.push({ gold: g, actual: best, score: bestScore });
}
const extras = beliefs.filter((a) => !usedActual.has(a.id));

function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderEntities(ents) {
	if (!ents || !ents.length) return '<span class="dim">none</span>';
	return ents
		.map((e) => `<span class="pill ${e.kind}">${escapeHtml(e.kind)}: ${escapeHtml(e.name)}</span>`)
		.join(' ');
}

function renderEvidence(ev) {
	if (!ev || !ev.length) return '<span class="dim">no evidence rows</span>';
	return ev
		.map(
			(o) =>
				`<div class="evidence"><span class="ew" style="color:${o.weight >= 0 ? '#88d9a8' : '#f08089'}">${(o.weight ?? 0).toFixed(2)}</span> ${escapeHtml(o.title || o.summary || '(no title)')}</div>`
		)
		.join('');
}

function renderPair(p, i) {
	const g = p.gold;
	const a = p.actual;
	const goldEnts = renderEntities(g.scope_entities);
	const actualEnts = a ? renderEntities(a.entities) : '<span class="dim">— no match —</span>';
	const evidence = a ? renderEvidence(a.evidence) : '';
	const matchScore = a ? `entity-overlap=${(p.score * 100).toFixed(0)}%` : 'NO MATCH';
	const matchColor = a && p.score >= 0.5 ? '#88d9a8' : a ? '#e0b97a' : '#f08089';
	return `
		<section class="pair" data-key="gold-${i}">
			<header>
				<span class="cn">G${i + 1}</span>
				<span class="match" style="color:${matchColor}">${matchScore}</span>
				<div class="vote">
					<button class="v-good" data-key="gold-${i}">✓</button>
					<button class="v-bad" data-key="gold-${i}">✗</button>
				</div>
			</header>
			<div class="grid">
				<div class="col">
					<h3>Gold belief</h3>
					<div class="claim gold-claim">${escapeHtml(g.claim)}</div>
					<div class="meta">confidence ${(g.confidence ?? 0).toFixed(2)} · scope: ${goldEnts}</div>
					${g.notes ? `<div class="notes-block">${escapeHtml(g.notes)}</div>` : ''}
				</div>
				<div class="col">
					<h3>Actual belief</h3>
					${a ? `
						<div class="claim actual-claim">${escapeHtml(a.claim)}</div>
						<div class="meta">confidence ${(a.confidence ?? 0).toFixed(2)} · ${a.explicitness} · scope: ${actualEnts}</div>
						<div class="evidence-list">${evidence}</div>
					` : '<div class="dim">No actual belief matched this gold by entity overlap. Either the belief former missed it, or it consolidated into a different gold pair.</div>'}
				</div>
			</div>
			<label class="notes-label">Notes (what to fix / merge / scope-correct):
				<textarea class="notes" data-key="gold-${i}" rows="2"></textarea>
			</label>
		</section>`;
}

function renderExtra(b, i) {
	return `
		<section class="pair extra" data-key="extra-${b.id}">
			<header>
				<span class="cn extra-tag">EXTRA ${i + 1}</span>
				<span class="match" style="color:#f08089">no gold match</span>
				<div class="vote">
					<button class="v-good" data-key="extra-${b.id}">✓ keep</button>
					<button class="v-bad" data-key="extra-${b.id}">✗ delete</button>
				</div>
			</header>
			<div class="grid single">
				<div class="col">
					<h3>Actual belief (no gold match)</h3>
					<div class="claim actual-claim">${escapeHtml(b.claim)}</div>
					<div class="meta">confidence ${(b.confidence ?? 0).toFixed(2)} · ${b.explicitness} · scope: ${renderEntities(b.entities)}</div>
					<div class="evidence-list">${renderEvidence(b.evidence)}</div>
				</div>
			</div>
			<label class="notes-label">Notes:
				<textarea class="notes" data-key="extra-${b.id}" rows="2"></textarea>
			</label>
		</section>`;
}

const totalGold = pairs.length;
const matched = pairs.filter((p) => p.actual && p.score >= 0.5).length;
const partial = pairs.filter((p) => p.actual && p.score < 0.5).length;
const missing = pairs.filter((p) => !p.actual).length;

const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>Belief review</title>
	<style>
		* { box-sizing: border-box; }
		body { font-family: -apple-system, BlinkMacSystemFont, ui-sans-serif, sans-serif; background: #0d0f12; color: #e6e6e6; margin: 0; padding: 20px 24px 80px; font-size: 13px; line-height: 1.45; }
		header.top { position: sticky; top: 0; background: #0d0f12; padding: 10px 0 14px; border-bottom: 1px solid #1f2329; margin-bottom: 18px; display: flex; align-items: center; gap: 16px; z-index: 100; }
		header.top h1 { margin: 0; font-size: 16px; }
		header.top .stats { color: #8a9099; font-size: 12px; }
		header.top button, header.top input[type=text] { background: #1a1d23; color: #e6e6e6; border: 1px solid #2a2f37; border-radius: 4px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
		.pair { border: 1px solid #1f2329; border-radius: 6px; margin: 0 0 18px; padding: 14px 18px; background: #14161b; }
		.pair.p-good { background: #131a14; border-color: #2a4a30; }
		.pair.p-bad { background: #1a1416; border-color: #4a2a30; }
		.pair.extra { background: #1c1922; }
		.pair header { margin: 0 0 12px; display: flex; align-items: center; gap: 10px; }
		.pair header .cn { background: #2a2f37; color: #c0c4cc; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
		.pair header .extra-tag { background: #4a2a30; color: #f08089; }
		.pair header .match { font-size: 11.5px; }
		.pair header .vote { margin-left: auto; display: flex; gap: 4px; }
		.pair header .vote button { background: #1f2329; border: 1px solid #2a2f37; color: #6c727b; padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 12px; }
		.pair header .vote .v-good.active { background: #2a4a30; border-color: #5fa676; color: #88d9a8; }
		.pair header .vote .v-bad.active { background: #4a2a30; border-color: #c4636b; color: #f08089; }
		.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
		.grid.single { grid-template-columns: 1fr; }
		.col h3 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; color: #8a9099; letter-spacing: 0.6px; }
		.claim { font-weight: 600; padding: 8px 10px; border-radius: 4px; }
		.gold-claim { background: #181a1f; border-left: 3px solid #d9a366; color: #f0d7a8; }
		.actual-claim { background: #181a1f; border-left: 3px solid #74c99a; color: #c8e8d4; }
		.meta { color: #8a9099; font-size: 11.5px; margin-top: 6px; }
		.notes-block { color: #c0c4cc; font-size: 11.5px; margin-top: 8px; padding: 6px 10px; background: #1a1d23; border-left: 2px solid #2a2f37; }
		.evidence-list { margin-top: 8px; max-height: 200px; overflow-y: auto; }
		.evidence { font-size: 11px; color: #8a9099; padding: 2px 0; border-bottom: 1px dashed #1f2329; }
		.ew { display: inline-block; min-width: 32px; font-family: monospace; }
		.pill { display: inline-block; padding: 2px 7px; margin: 2px 4px 2px 0; border-radius: 3px; font-size: 11px; }
		.pill.property { background: #3a2e1c; color: #e0b97a; }
		.pill.vendor { background: #1c3a26; color: #88d9a8; }
		.pill.owner { background: #1c2a3a; color: #7aaae0; }
		.notes-label { display: block; margin-top: 10px; font-size: 11.5px; color: #8a9099; }
		.notes { width: 100%; background: #1a1d23; color: #e6e6e6; border: 1px solid #2a2f37; border-radius: 4px; padding: 8px 10px; font-family: inherit; font-size: 12.5px; resize: vertical; margin-top: 4px; }
		.dim { color: #6c727b; }
		.section-divider { margin: 36px 0 18px; padding-bottom: 6px; border-bottom: 2px solid #2a2f37; font-size: 13px; color: #8a9099; text-transform: uppercase; letter-spacing: 0.8px; }
	</style>
</head>
<body>
	<header class="top">
		<h1>Belief review</h1>
		<span class="stats" id="stats"></span>
		<button id="export-btn">export state</button>
		<button id="clear-btn">clear all</button>
	</header>

	<div class="section-divider">Gold beliefs (${totalGold}) · ${matched} solid match · ${partial} partial · ${missing} no match</div>
	${pairs.map((p, i) => renderPair(p, i)).join('\n')}

	${extras.length ? `<div class="section-divider">Extra actual beliefs (${extras.length}) — not paired with any gold</div>${extras.map((b, i) => renderExtra(b, i)).join('\n')}` : ''}

	<script>
		const STORAGE_KEY = 'belief-review-${WORKSPACE}';
		const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		if (!state.votes) state.votes = {};
		if (!state.notes) state.notes = {};

		function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); updateStats(); }
		function updateStats() {
			const total = document.querySelectorAll('.pair').length;
			const good = Object.values(state.votes).filter((v) => v === 'good').length;
			const bad = Object.values(state.votes).filter((v) => v === 'bad').length;
			document.getElementById('stats').textContent = good + ' good · ' + bad + ' bad · ' + (total - good - bad) + ' pending';
		}
		function applyState() {
			document.querySelectorAll('.pair').forEach((sec) => {
				const key = sec.dataset.key;
				const v = state.votes[key];
				sec.classList.toggle('p-good', v === 'good');
				sec.classList.toggle('p-bad', v === 'bad');
				sec.querySelectorAll('.v-good').forEach((b) => b.classList.toggle('active', v === 'good'));
				sec.querySelectorAll('.v-bad').forEach((b) => b.classList.toggle('active', v === 'bad'));
				const ta = sec.querySelector('.notes');
				if (ta) ta.value = state.notes[key] || '';
			});
			updateStats();
		}
		document.querySelectorAll('.v-good, .v-bad').forEach((btn) => {
			btn.addEventListener('click', () => {
				const key = btn.dataset.key;
				const vote = btn.classList.contains('v-good') ? 'good' : 'bad';
				if (state.votes[key] === vote) delete state.votes[key];
				else state.votes[key] = vote;
				persist(); applyState();
			});
		});
		document.querySelectorAll('.notes').forEach((ta) => {
			ta.addEventListener('input', () => {
				const key = ta.dataset.key;
				state.notes[key] = ta.value;
				if (!ta.value) delete state.notes[key];
				persist();
			});
		});
		document.getElementById('export-btn').addEventListener('click', () => {
			navigator.clipboard.writeText(JSON.stringify(state, null, 2));
			alert('State copied.');
		});
		document.getElementById('clear-btn').addEventListener('click', () => {
			if (confirm('Clear all?')) { localStorage.removeItem(STORAGE_KEY); location.reload(); }
		});
		applyState();
	</script>
</body>
</html>`;

const outPath = path.join(AGENT_ROOT, 'evals', 'memory-graph', 'belief-review.html');
await fs.writeFile(outPath, html, 'utf8');
console.log(`Wrote ${outPath} (${pairs.length} gold pairs + ${extras.length} extras)`);
console.log(`Open: file://${outPath}`);
