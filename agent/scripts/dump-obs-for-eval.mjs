#!/usr/bin/env node
// Read-only: dump every observation alongside the expected observations from
// observations.gold.json, as a side-by-side HTML review checklist.
//
// Output: agent/evals/memory-graph/obs-review.html
// Open in a browser; check off each obs as you verify. Checkbox state persists
// in localStorage. Use "export" to copy the current marked state.

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
	console.error('Need PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.');
	process.exit(1);
}
const WORKSPACE = '2e4373a0-40b8-42c2-a873-b08c99dbf76a'; // prod

function headers() {
	return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' };
}

async function fetchAll(pathname) {
	const res = await fetch(`${SUPABASE_URL}${pathname}`, { headers: headers() });
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json();
}

console.log('Fetching observations + entity links + sessions…');

const observations = await fetchAll(
	`/rest/v1/observations?select=id,session_id,title,summary,raw_text,salience,tags,ts&workspace_id=eq.${WORKSPACE}&order=ts.asc&limit=500`
);
const obsEntities = await fetchAll(
	`/rest/v1/observation_entities?select=observation_id,entity_id,weight,observation:observations!inner(workspace_id)&observation.workspace_id=eq.${WORKSPACE}`
);
const entities = await fetchAll(
	`/rest/v1/entities?select=id,kind,name&workspace_id=eq.${WORKSPACE}&limit=500`
);
const sessions = await fetchAll(
	`/rest/v1/chat_sessions?select=id,started_at,summary&workspace_id=eq.${WORKSPACE}&order=started_at.asc&limit=200`
);

const entityById = new Map(entities.map((e) => [e.id, e]));

// Group entities per obs
const entitiesByObs = new Map();
for (const oe of obsEntities) {
	const ent = entityById.get(oe.entity_id);
	if (!ent) continue;
	if (!entitiesByObs.has(oe.observation_id)) entitiesByObs.set(oe.observation_id, []);
	entitiesByObs.get(oe.observation_id).push({ ...ent, weight: oe.weight });
}

// Group obs per session
const obsBySession = new Map();
for (const o of observations) {
	if (!obsBySession.has(o.session_id)) obsBySession.set(o.session_id, []);
	obsBySession.get(o.session_id).push({ ...o, entities: entitiesByObs.get(o.id) || [] });
}

// Read gold
const goldPath = path.join(AGENT_ROOT, 'evals', 'memory-graph', 'observations.gold.json');
const gold = JSON.parse(await fs.readFile(goldPath, 'utf8'));

const sessionById = new Map(sessions.map((s) => [s.id, s]));

// Build per-session blocks
const blocks = [];
const seenSessionIds = new Set();
for (const g of gold) {
	const sess = sessionById.get(g.session_id);
	const actual = obsBySession.get(g.session_id) || [];
	blocks.push({
		session_id: g.session_id,
		started_at: g.started_at,
		topic: g.topic,
		session_summary: sess?.summary || '',
		expected: g.expected_observations || [],
		actual,
		gold_notes: g.notes || []
	});
	seenSessionIds.add(g.session_id);
}
// Add bonus sessions that have actual obs but aren't in gold
for (const [sess_id, actual] of obsBySession) {
	if (seenSessionIds.has(sess_id)) continue;
	const sess = sessionById.get(sess_id);
	blocks.push({
		session_id: sess_id,
		started_at: sess?.started_at || '',
		topic: '(bonus — not in gold)',
		session_summary: sess?.summary || '',
		expected: [],
		actual,
		gold_notes: []
	});
}

function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderEntities(ents, mode) {
	if (!ents || !ents.length) return '<span class="dim">none</span>';
	return ents
		.map((e) => {
			const isNeg = mode === 'actual' && (e.weight ?? 1) < 0;
			const weightLabel =
				mode === 'actual' && e.weight !== 1 ? ` <span class="w">(${(e.weight ?? 0).toFixed(1)})</span>` : '';
			return `<span class="pill ${e.kind}${isNeg ? ' neg' : ''}">${escapeHtml(e.kind)}: ${escapeHtml(e.name)}${weightLabel}</span>`;
		})
		.join(' ');
}

function renderExpectedObs(e, idx, sessId) {
	const ents = e.entities
		? e.entities.map((x) => ({ kind: x.kind, name: x.name }))
		: [];
	// No checkbox on gold — it's read-only reference.
	return `
		<div class="obs gold">
			<div class="obs-body">
				<div class="title">${escapeHtml(e.title || '(no title)')}</div>
				<div class="summary">${escapeHtml(e.summary || '')}</div>
				<div class="ents">${renderEntities(ents, 'gold')}</div>
				<div class="quote">${e.source_quote ? '"' + escapeHtml(e.source_quote) + '"' : '<span class="dim">no quote</span>'}</div>
				<div class="tags">${(e.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</div>
			</div>
		</div>`;
}

function renderActualObs(o, idx, sessId) {
	const id = `actual-${o.id}`;
	return `
		<div class="obs actual">
			<div class="vote">
				<button class="v-good" data-id="${id}" title="this obs is correct">✓</button>
				<button class="v-bad" data-id="${id}" title="this obs is wrong / over-extracted">✗</button>
			</div>
			<div class="obs-body">
				<div class="title">${escapeHtml(o.title || '(no title)')}</div>
				<div class="summary">${escapeHtml(o.summary || '')}</div>
				<div class="ents">${renderEntities(o.entities, 'actual')}</div>
				<div class="quote">${o.raw_text ? '"' + escapeHtml(o.raw_text) + '"' : '<span class="dim">no quote</span>'}</div>
				<div class="tags">${(o.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</div>
			</div>
		</div>`;
}

const sessionsHtml = blocks
	.map((b, i) => {
		const dateStr = b.started_at ? new Date(b.started_at).toISOString().slice(0, 16).replace('T', ' ') : '';
		const expCount = b.expected.length;
		const actCount = b.actual.length;
		const expBody = b.expected.length
			? b.expected.map((e, idx) => renderExpectedObs(e, idx, b.session_id)).join('')
			: '<div class="dim">no expected obs (session marked empty in gold)</div>';
		const actBody = b.actual.length
			? b.actual.map((o, idx) => renderActualObs(o, idx, b.session_id)).join('')
			: '<div class="dim">no actual obs</div>';
		const notesBody = b.gold_notes.length
			? `<details class="notes"><summary>gold notes (${b.gold_notes.length})</summary>${b.gold_notes.map((n) => `<div class="note">${escapeHtml(n)}</div>`).join('')}</details>`
			: '';
		const summaryBody = b.session_summary
			? `<details class="notes"><summary>session summary</summary><div class="note">${escapeHtml(b.session_summary)}</div></details>`
			: '';
		return `
			<section class="session" data-sess="${b.session_id}">
				<h2>
					<span class="sn">S${i + 1}</span>
					<span class="topic">${escapeHtml(b.topic || '')}</span>
					<span class="meta">${escapeHtml(dateStr)} · expected ${expCount} / actual ${actCount}</span>
					<button class="mark-all" data-sess="${b.session_id}">mark all</button>
				</h2>
				${summaryBody}
				${notesBody}
				<div class="grid">
					<div class="col">
						<h3>Expected (gold)</h3>
						${expBody}
					</div>
					<div class="col">
						<h3>Actual (DB)</h3>
						${actBody}
					</div>
				</div>
			</section>`;
	})
	.join('\n');

const totalExpected = blocks.reduce((n, b) => n + b.expected.length, 0);
const totalActual = blocks.reduce((n, b) => n + b.actual.length, 0);

const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>Observations review</title>
	<style>
		* { box-sizing: border-box; }
		body { font-family: -apple-system, BlinkMacSystemFont, ui-sans-serif, sans-serif; background: #0d0f12; color: #e6e6e6; margin: 0; padding: 20px 24px 80px; font-size: 13px; line-height: 1.45; }
		header.top { position: sticky; top: 0; background: #0d0f12; padding: 10px 0 14px; border-bottom: 1px solid #1f2329; margin-bottom: 18px; display: flex; align-items: center; gap: 16px; z-index: 100; }
		header.top h1 { margin: 0; font-size: 16px; }
		header.top .stats { color: #8a9099; font-size: 12px; }
		header.top button, header.top input[type=text] { background: #1a1d23; color: #e6e6e6; border: 1px solid #2a2f37; border-radius: 4px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
		header.top input[type=text] { width: 200px; }
		header.top button:hover { background: #21262d; }
		.session { border: 1px solid #1f2329; border-radius: 6px; margin: 0 0 20px; padding: 14px 18px; background: #14161b; }
		.session h2 { margin: 0 0 12px; font-size: 14px; display: flex; align-items: center; gap: 10px; }
		.session h2 .sn { background: #2a2f37; color: #c0c4cc; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: normal; }
		.session h2 .topic { font-weight: 600; }
		.session h2 .meta { color: #8a9099; font-weight: normal; font-size: 11.5px; margin-left: auto; }
		.session h2 .mark-all { background: #1a1d23; color: #8a9099; border: 1px solid #2a2f37; border-radius: 3px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
		.session h2 .mark-all:hover { color: #e6e6e6; }
		.session.session-done { background: #131a14; border-color: #2a4a30; }
		details.notes { margin-bottom: 10px; }
		details.notes summary { color: #8a9099; cursor: pointer; font-size: 11.5px; user-select: none; }
		details.notes .note { background: #1a1d23; border-left: 2px solid #2a2f37; padding: 6px 10px; margin: 6px 0; color: #c0c4cc; font-size: 11.5px; }
		.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
		.col h3 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; color: #8a9099; letter-spacing: 0.6px; }
		.obs { margin-bottom: 8px; border-radius: 4px; padding: 8px 10px; background: #1a1d23; border-left: 3px solid #2a2f37; transition: background 0.1s; display: flex; gap: 10px; }
		.obs.gold { border-left-color: #d9a366; }
		.obs.actual { border-left-color: #74c99a; }
		.obs.obs-good { background: #131a14; border-left-color: #5fa676; }
		.obs.obs-bad { background: #1a1416; border-left-color: #c4636b; opacity: 0.85; }
		.obs-body { flex: 1; min-width: 0; }
		.vote { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
		.vote button { background: #1f2329; border: 1px solid #2a2f37; color: #6c727b; width: 24px; height: 22px; border-radius: 3px; cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }
		.vote button:hover { color: #e6e6e6; }
		.vote .v-good.active { background: #2a4a30; border-color: #5fa676; color: #88d9a8; }
		.vote .v-bad.active { background: #4a2a30; border-color: #c4636b; color: #f08089; }
		.title { font-weight: 600; color: #e6e6e6; }
		.summary { color: #c0c4cc; margin: 3px 0; }
		.ents { margin: 4px 0; }
		.pill { display: inline-block; padding: 2px 7px; margin: 2px 4px 2px 0; border-radius: 3px; background: #2a2f37; color: #c0c4cc; font-size: 11px; }
		.pill.property { background: #3a2e1c; color: #e0b97a; }
		.pill.vendor { background: #1c3a26; color: #88d9a8; }
		.pill.owner { background: #1c2a3a; color: #7aaae0; }
		.pill.neg { opacity: 0.55; text-decoration: line-through; }
		.pill .w { font-size: 9.5px; opacity: 0.7; }
		.quote { color: #8a9099; font-style: italic; font-size: 11.5px; margin: 4px 0; }
		.tags { margin-top: 3px; }
		.tag { display: inline-block; padding: 1px 6px; margin: 1px 3px 1px 0; border-radius: 3px; background: #1f2329; color: #8a9099; font-size: 10px; }
		.dim { color: #6c727b; }
		.hidden { display: none; }
	</style>
</head>
<body>
	<header class="top">
		<h1>Observations review</h1>
		<span class="stats" id="stats"></span>
		<input type="text" id="filter" placeholder="filter by session topic, title, entity…">
		<label style="font-size:11.5px;color:#8a9099"><input type="checkbox" id="hide-done"> hide done</label>
		<button id="export-btn">export marked</button>
		<button id="clear-btn">clear all</button>
	</header>
	${sessionsHtml}
	<script>
		const STORAGE_KEY = 'obs-review-${WORKSPACE}';
		// state[id] = 'good' | 'bad' | undefined
		const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

		function persist() {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
			updateStats();
		}

		function setVote(id, vote) {
			if (state[id] === vote) {
				delete state[id]; // toggle off
			} else {
				state[id] = vote;
			}
			applyState();
			persist();
		}

		function applyState() {
			document.querySelectorAll('.obs.actual').forEach((row) => {
				const btnGood = row.querySelector('.v-good');
				const btnBad = row.querySelector('.v-bad');
				if (!btnGood) return;
				const id = btnGood.dataset.id;
				const v = state[id];
				row.classList.toggle('obs-good', v === 'good');
				row.classList.toggle('obs-bad', v === 'bad');
				btnGood.classList.toggle('active', v === 'good');
				btnBad.classList.toggle('active', v === 'bad');
			});
			document.querySelectorAll('.session').forEach((sec) => {
				const rows = sec.querySelectorAll('.obs.actual');
				const total = rows.length;
				const voted = [...rows].filter((r) => r.classList.contains('obs-good') || r.classList.contains('obs-bad')).length;
				sec.classList.toggle('session-done', total > 0 && voted === total);
			});
			updateStats();
		}

		function updateStats() {
			const all = document.querySelectorAll('.obs.actual').length;
			const good = Object.values(state).filter((v) => v === 'good').length;
			const bad = Object.values(state).filter((v) => v === 'bad').length;
			const sessions = document.querySelectorAll('.session').length;
			const doneSessions = document.querySelectorAll('.session.session-done').length;
			document.getElementById('stats').textContent =
				doneSessions + '/' + sessions + ' sessions · ' + good + ' good · ' + bad + ' bad · ' + (all - good - bad) + ' pending';
		}

		document.querySelectorAll('.v-good, .v-bad').forEach((btn) => {
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				const vote = btn.classList.contains('v-good') ? 'good' : 'bad';
				setVote(btn.dataset.id, vote);
			});
		});

		document.querySelectorAll('.mark-all').forEach((btn) => {
			btn.addEventListener('click', () => {
				const sec = btn.closest('.session');
				sec.querySelectorAll('.obs.actual .v-good').forEach((b) => {
					state[b.dataset.id] = 'good';
				});
				applyState();
				persist();
			});
		});

		document.getElementById('export-btn').addEventListener('click', () => {
			navigator.clipboard.writeText(JSON.stringify(state, null, 2));
			alert('Marked state copied to clipboard (' + Object.keys(state).filter((k)=>state[k]).length + ' entries)');
		});

		document.getElementById('clear-btn').addEventListener('click', () => {
			if (confirm('Clear all checks?')) {
				for (const k of Object.keys(state)) delete state[k];
				persist();
				applyState();
			}
		});

		const filterEl = document.getElementById('filter');
		const hideDoneEl = document.getElementById('hide-done');
		function applyFilter() {
			const q = filterEl.value.trim().toLowerCase();
			const hideDone = hideDoneEl.checked;
			document.querySelectorAll('.session').forEach((sec) => {
				const text = sec.textContent.toLowerCase();
				const matchesQ = !q || text.includes(q);
				const isDone = sec.classList.contains('session-done');
				const hidden = !matchesQ || (hideDone && isDone);
				sec.classList.toggle('hidden', hidden);
			});
		}
		filterEl.addEventListener('input', applyFilter);
		hideDoneEl.addEventListener('change', applyFilter);

		applyState();
	</script>
</body>
</html>`;

const outPath = path.join(AGENT_ROOT, 'evals', 'memory-graph', 'obs-review.html');
await fs.writeFile(outPath, html, 'utf8');
console.log(
	`Wrote ${outPath} (${blocks.length} sessions · gold=${totalExpected} · actual=${totalActual})`
);
console.log(`Open: file://${outPath}`);
