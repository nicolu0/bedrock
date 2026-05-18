#!/usr/bin/env node
// Build a side-by-side HTML for the belief-formation walkthrough:
// (1) Cluster current observations by overlapping entity-set + topic + owner
//     cascade, (2) Propose 1-3 beliefs per cluster, (3) Render with ✓/✗ vote
//     + notes textarea + a STAGING AREA for moving obs between clusters.
//
// UX for moving obs:
//   - Each obs has a small "eject" (×) button. Click → obs moves to staging.
//   - Staging area is a fixed bottom bar. Click a staged obs to select it.
//   - Each cluster has a "+ add staged" button that pulls selected obs in.
//
// Output: agent/evals/memory-graph/belief-clusters-review.html

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

console.log('Fetching obs + entities + structural edges…');

const observations = await fetchAll(
	`/rest/v1/observations?select=id,session_id,title,summary,raw_text,salience,tags,ts&workspace_id=eq.${WORKSPACE}&order=ts.asc&limit=500`
);
const obsEntities = await fetchAll(
	`/rest/v1/observation_entities?select=observation_id,entity_id,weight,observation:observations!inner(workspace_id)&observation.workspace_id=eq.${WORKSPACE}`
);
const entities = await fetchAll(
	`/rest/v1/entities?select=id,kind,name,ref_id&workspace_id=eq.${WORKSPACE}&limit=500`
);
const ownerProperties = await fetchAll(
	`/rest/v1/owner_properties?select=property_id,owner_id&workspace_id=eq.${WORKSPACE}`
);

const entityById = new Map(entities.map((e) => [e.id, e]));

// property entity → set of owner entity ids (via legacy owner_properties)
const ownersByPropertyEntity = new Map();
for (const op of ownerProperties) {
	const p = entities.find((e) => e.kind === 'property' && e.ref_id === op.property_id);
	const o = entities.find((e) => e.kind === 'owner' && e.ref_id === op.owner_id);
	if (!p || !o) continue;
	if (!ownersByPropertyEntity.has(p.id)) ownersByPropertyEntity.set(p.id, new Set());
	ownersByPropertyEntity.get(p.id).add(o.id);
}

for (const o of observations) {
	o.pos = [];
	o.neg = [];
}
const obsById = new Map(observations.map((o) => [o.id, o]));
for (const oe of obsEntities) {
	const obs = obsById.get(oe.observation_id);
	if (!obs) continue;
	const ent = entityById.get(oe.entity_id);
	if (!ent) continue;
	const ref = { ...ent, weight: oe.weight ?? 1 };
	if (oe.weight >= 0) obs.pos.push(ref);
	else obs.neg.push(ref);
}

// ── Cascade: for each obs, derive its OWNER set (via property → owner) ───
for (const o of observations) {
	const owners = new Set();
	for (const e of o.pos) {
		if (e.kind === 'owner') owners.add(e.id);
		if (e.kind === 'property') {
			const set = ownersByPropertyEntity.get(e.id);
			if (set) for (const oid of set) owners.add(oid);
		}
	}
	o.cascaded_owners = [...owners];
}

// ── CLUSTERING HEURISTIC ─────────────────────────────────────────────────

const TAG_PRIORITY = [
	'vendor-retirement',
	'pm-asked-to-remember',
	'pm-stated-rule',
	'pm-stated-preference',
	'pm-self-handle',
	'owner-approval-required',
	'pm-tenant-coordination',
	'pm-owner-coordination',
	'tenant-acts-as-manager',
	'vendor-contract',
	'tre-elevators-default',
	'harrison-handyman',
	'yonic-plumbing-default',
	'pest',
	'plumbing',
	'electrical',
	'appliance',
	'handyman',
	'fire-alarm',
	'gates',
	'elevator',
	'roofing'
];

function dominantTag(tags) {
	for (const t of TAG_PRIORITY) {
		if (tags && tags.includes(t)) return t;
	}
	return (tags && tags[0]) || 'general';
}

// Trade-tag set used to flag an obs as MAINTENANCE domain. Anything not on
// this list and not on the PM_TAGS list ends up "other".
const TRADE_TAGS = new Set([
	'plumbing', 'electrical', 'appliance', 'fire-alarm', 'pest', 'handyman',
	'roofing', 'gates', 'elevator', 'water-heater', 'drain', 'fridge', 'oven',
	'dishwasher', 'doorknob', 'shower', 'closet-door', 'curtain-rod',
	'screen-door', 'window-screen', 'heatlamp', 'lighting', 'garage-door',
	'call-box', 'toilet', 'toilet-seat', 'toilet-handle', 'shower-drain',
	'water-leak', 'ice-maker', 'bathtub', 'gutters', 'skylight', 'breaker',
	'flickering-lights', 'garbage-disposal', 'disposal', 'paint', 'tree-trimming',
	'washing-machine', 'co-alarm', 'carbon-monoxide', 'rats', 'blinds'
]);
const PM_TAGS = new Set([
	'non-maintenance', 'homeless-security', 'security', 'tenant-comm-channel',
	'tenant-acts-as-manager', 'pm-tenant-coordination', 'noise-complaint',
	'tenant-behavior-suspected', 'personal-handling'
]);

function obsDomain(tags) {
	if (!tags || !tags.length) return 'other';
	if (tags.some((t) => PM_TAGS.has(t))) return 'property-mgmt';
	if (tags.some((t) => TRADE_TAGS.has(t))) return 'maintenance';
	return 'other';
}

function anchorEntity(obs) {
	const posVendor = obs.pos.find((e) => e.kind === 'vendor');
	if (posVendor) return posVendor;
	const posOwner = obs.pos.find((e) => e.kind === 'owner');
	if (posOwner) return posOwner;
	const posProp = obs.pos.find((e) => e.kind === 'property');
	if (posProp) return posProp;
	return null;
}

const clusterByKey = new Map();
for (const o of observations) {
	const anchor = anchorEntity(o);
	const tag = dominantTag(o.tags);
	const domain = obsDomain(o.tags);
	o.domain = domain;
	// Include domain in the cluster key so e.g. JL-self-handle splits into
	// maintenance vs property-mgmt buckets (homeless encampment goes
	// somewhere different from fire alarm repairs).
	const key = anchor ? `${anchor.kind}:${anchor.id}:${tag}:${domain}` : `none:${tag}:${domain}`;
	if (!clusterByKey.has(key)) {
		clusterByKey.set(key, { key, anchor, tag, domain, obs: [] });
	}
	clusterByKey.get(key).obs.push(o);
}

const clusters = [...clusterByKey.values()].sort((a, b) => {
	if (b.obs.length !== a.obs.length) return b.obs.length - a.obs.length;
	return a.key.localeCompare(b.key);
});

// ── BELIEF PROPOSAL with owner-cascade detection ─────────────────────────

function proposeBeliefs(cluster) {
	const n = cluster.obs.length;
	const trades = new Set();
	for (const o of cluster.obs) for (const t of o.tags || []) trades.add(t);
	const tradeHint = [...trades]
		.filter(
			(t) =>
				![
					'vendor-dispatch',
					'vendor-override',
					'pm-self-handle',
					'vendor-preference',
					'pm-stated-preference',
					'pm-stated-rule',
					'status-resolved',
					'recurring-treatment',
					'pm-declined-self-handle',
					'pm-asked-to-remember',
					'vendor-preference-stated'
				].includes(t)
		)
		.slice(0, 3)
		.join(', ');

	const props = [];
	if (!cluster.anchor) {
		props.push({
			claim: 'Unclustered observation — review individually.',
			scope_entities: [],
			confidence: 0.3
		});
		return props;
	}

	const a = cluster.anchor;

	// Vendor retirement (special case)
	if (a.kind === 'vendor' && cluster.tag === 'vendor-retirement') {
		props.push({
			claim: `${a.name} is retired — do not dispatch.`,
			scope_entities: [{ kind: 'vendor', name: a.name }],
			confidence: 0.95
		});
		return props;
	}

	// Vendor cluster
	if (a.kind === 'vendor') {
		const trade = tradeHint || cluster.tag;

		// Check owner cascade: do most obs share a single owner?
		const ownerCounts = new Map();
		let obsWithOwners = 0;
		for (const o of cluster.obs) {
			if (o.cascaded_owners.length === 0) continue;
			obsWithOwners++;
			for (const oid of o.cascaded_owners) {
				ownerCounts.set(oid, (ownerCounts.get(oid) || 0) + 1);
			}
		}
		// Find dominant owner: >= ceil(obsWithOwners / 2) and >= 2 obs
		let dominantOwnerId = null;
		let dominantOwnerCount = 0;
		for (const [oid, count] of ownerCounts) {
			if (count >= 2 && count >= Math.ceil(obsWithOwners / 2) && count > dominantOwnerCount) {
				dominantOwnerId = oid;
				dominantOwnerCount = count;
			}
		}
		const dominantOwner = dominantOwnerId ? entityById.get(dominantOwnerId) : null;

		// Vendor-wide capability belief
		if (cluster.tag === 'pm-self-handle') {
			if (cluster.domain === 'property-mgmt') {
				props.push({
					claim: `Jose personally handles property-management situations (security, tenant escalations, homeless encampments, owner-relations issues) — not via a vendor.`,
					scope_entities: [{ kind: 'vendor', name: a.name }],
					confidence: n >= 2 ? 0.7 : 0.5
				});
			} else {
				props.push({
					claim: `Jose frequently self-handles minor maintenance repairs at properties he manages directly.`,
					scope_entities: [{ kind: 'vendor', name: a.name }],
					confidence: n >= 3 ? 0.7 : 0.45
				});
			}
		} else {
			props.push({
				claim: `${a.name} handles ${trade} issues${n === 1 ? ' (single obs — low confidence)' : ''}.`,
				scope_entities: [{ kind: 'vendor', name: a.name }],
				confidence: n >= 3 ? 0.75 : n === 2 ? 0.5 : 0.3
			});
		}

		// Owner-scoped variant (if owner cascade gives us a dominant owner)
		if (dominantOwner && dominantOwnerCount >= 2) {
			props.push({
				claim: `${a.name} handles ${trade} issues at ${dominantOwner.name} properties.`,
				scope_entities: [
					{ kind: 'vendor', name: a.name },
					{ kind: 'owner', name: dominantOwner.name }
				],
				confidence: dominantOwnerCount >= 3 ? 0.8 : 0.6
			});
		}

		// Single-property variant (all obs share one property)
		const propSet = new Set();
		for (const o of cluster.obs) for (const p of o.pos.filter((x) => x.kind === 'property')) propSet.add(p.name);
		if (propSet.size === 1 && n >= 2) {
			const propName = [...propSet][0];
			props.push({
				claim: `${a.name} is the default vendor for ${trade} at ${propName}.`,
				scope_entities: [
					{ kind: 'vendor', name: a.name },
					{ kind: 'property', name: propName }
				],
				confidence: 0.7
			});
		}
		return props;
	}

	// Owner cluster
	if (a.kind === 'owner') {
		props.push({
			claim: `${a.name} ${cluster.tag === 'owner-approval-required' ? 'requires owner approval before vendor dispatch' : 'has property-management quirk to capture'}.`,
			scope_entities: [{ kind: 'owner', name: a.name }],
			confidence: 0.9
		});
		return props;
	}

	// Property cluster
	props.push({
		claim: `${a.name} property-specific quirk: ${tradeHint || cluster.tag}.`,
		scope_entities: [{ kind: 'property', name: a.name }],
		confidence: 0.6
	});
	return props;
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
			return `<span class="pill ${e.kind}${isNeg ? ' neg' : ''}">${escapeHtml(e.kind)}: ${escapeHtml(e.name)}</span>`;
		})
		.join(' ');
}

function clusterAnchorLabel(c) {
	const domainSuffix = c.domain && c.domain !== 'maintenance' ? ` · ${c.domain}` : '';
	if (!c.anchor) return `(no anchor) · ${c.tag}${domainSuffix}`;
	return `${c.anchor.kind}: ${c.anchor.name} · ${c.tag}${domainSuffix}`;
}

function renderObs(o) {
	const cascadedNames = o.cascaded_owners
		.map((id) => entityById.get(id))
		.filter(Boolean)
		.map((e) => e.name)
		.join(', ');
	const cascadeStr = cascadedNames ? ` <span class="dim">(owner: ${escapeHtml(cascadedNames)})</span>` : '';
	return `
		<div class="obs" data-obs-id="${o.id}">
			<button class="eject-btn" data-obs-id="${o.id}" title="eject to staging">×</button>
			<div class="obs-body">
				<div class="title">${escapeHtml(o.title || '(no title)')}${cascadeStr}</div>
				<div class="summary">${escapeHtml(o.summary || '')}</div>
				<div class="ents">${renderEntities(o.pos, 'actual')} ${renderEntities(o.neg, 'actual')}</div>
			</div>
		</div>`;
}

const clustersHtml = clusters
	.map((c, i) => {
		const beliefs = proposeBeliefs(c);
		const beliefsHtml = beliefs
			.map(
				(b) => `
				<div class="belief">
					<div class="claim">${escapeHtml(b.claim)}</div>
					<div class="meta">
						confidence ${b.confidence.toFixed(2)} ·
						scope: ${renderEntities(b.scope_entities, 'gold') || '<span class="dim">vendor-wide</span>'}
					</div>
				</div>`
			)
			.join('');
		return `
		<section class="cluster" data-cluster-key="${escapeHtml(c.key)}">
			<header>
				<span class="cn">C${i + 1}</span>
				<span class="anchor">${escapeHtml(clusterAnchorLabel(c))}</span>
				<span class="count" data-count>${c.obs.length} obs</span>
				<button class="add-staged-btn" data-cluster-key="${escapeHtml(c.key)}">+ add selected</button>
				<div class="vote">
					<button class="v-good" data-key="${escapeHtml(c.key)}" title="cluster + beliefs good">✓</button>
					<button class="v-bad" data-key="${escapeHtml(c.key)}" title="cluster or beliefs wrong">✗</button>
				</div>
			</header>
			<div class="grid">
				<div class="col obs-col" data-cluster-obs-container="${escapeHtml(c.key)}">
					<h3>Observations</h3>
					${c.obs.map((o) => renderObs(o)).join('')}
				</div>
				<div class="col belief-col">
					<h3>Proposed beliefs</h3>
					${beliefsHtml}
					<label class="notes-label">Notes (denial reason / belief edits / cluster suggestions):
						<textarea class="notes" data-key="${escapeHtml(c.key)}" rows="3" placeholder="why you denied / what to fix…"></textarea>
					</label>
				</div>
			</div>
		</section>`;
	})
	.join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>Belief clusters review</title>
	<style>
		* { box-sizing: border-box; }
		body { font-family: -apple-system, BlinkMacSystemFont, ui-sans-serif, sans-serif; background: #0d0f12; color: #e6e6e6; margin: 0; padding: 20px 24px 140px; font-size: 13px; line-height: 1.45; }
		header.top { position: sticky; top: 0; background: #0d0f12; padding: 10px 0 14px; border-bottom: 1px solid #1f2329; margin-bottom: 18px; display: flex; align-items: center; gap: 16px; z-index: 100; }
		header.top h1 { margin: 0; font-size: 16px; }
		header.top .stats { color: #8a9099; font-size: 12px; }
		header.top button, header.top input[type=text] { background: #1a1d23; color: #e6e6e6; border: 1px solid #2a2f37; border-radius: 4px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
		header.top input[type=text] { width: 200px; }
		.cluster { border: 1px solid #1f2329; border-radius: 6px; margin: 0 0 20px; padding: 14px 18px; background: #14161b; }
		.cluster.c-good { background: #131a14; border-color: #2a4a30; }
		.cluster.c-bad { background: #1a1416; border-color: #4a2a30; }
		.cluster header { margin: 0 0 12px; font-size: 14px; display: flex; align-items: center; gap: 10px; }
		.cluster header .cn { background: #2a2f37; color: #c0c4cc; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
		.cluster header .anchor { font-weight: 600; }
		.cluster header .count { color: #8a9099; font-size: 11.5px; }
		.cluster header .add-staged-btn { background: #1a1d23; color: #8a9099; border: 1px solid #2a2f37; border-radius: 3px; padding: 3px 9px; font-size: 11px; cursor: pointer; }
		.cluster header .add-staged-btn:hover:not(:disabled) { color: #88d9a8; border-color: #5fa676; }
		.cluster header .add-staged-btn:disabled { opacity: 0.4; cursor: not-allowed; }
		.cluster header .vote { margin-left: auto; display: flex; gap: 4px; }
		.cluster header .vote button { background: #1f2329; border: 1px solid #2a2f37; color: #6c727b; width: 26px; height: 24px; border-radius: 3px; cursor: pointer; font-size: 14px; }
		.cluster header .vote .v-good.active { background: #2a4a30; border-color: #5fa676; color: #88d9a8; }
		.cluster header .vote .v-bad.active { background: #4a2a30; border-color: #c4636b; color: #f08089; }
		.grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 14px; }
		.col h3 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; color: #8a9099; letter-spacing: 0.6px; }
		.obs { margin-bottom: 8px; border-radius: 4px; padding: 8px 10px; background: #1a1d23; border-left: 3px solid #74c99a; display: flex; gap: 8px; transition: opacity 0.15s; }
		.obs.ejected { opacity: 0.25; text-decoration: line-through; }
		.eject-btn { background: transparent; border: 1px solid #2a2f37; color: #6c727b; width: 20px; height: 20px; border-radius: 3px; cursor: pointer; padding: 0; font-size: 12px; line-height: 1; flex-shrink: 0; align-self: flex-start; }
		.eject-btn:hover { color: #f08089; border-color: #c4636b; }
		.obs-body { flex: 1; min-width: 0; }
		.obs .title { font-weight: 600; }
		.obs .summary { color: #c0c4cc; margin: 3px 0; }
		.obs .ents { margin: 4px 0 0; }
		.pill { display: inline-block; padding: 2px 7px; margin: 2px 4px 2px 0; border-radius: 3px; background: #2a2f37; color: #c0c4cc; font-size: 11px; }
		.pill.property { background: #3a2e1c; color: #e0b97a; }
		.pill.vendor { background: #1c3a26; color: #88d9a8; }
		.pill.owner { background: #1c2a3a; color: #7aaae0; }
		.pill.neg { opacity: 0.5; text-decoration: line-through; }
		.belief { background: #181a1f; border-left: 3px solid #d9a366; border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; }
		.belief .claim { font-weight: 600; color: #f0d7a8; }
		.belief .meta { color: #8a9099; font-size: 11.5px; margin-top: 4px; }
		.notes-label { display: block; margin-top: 10px; font-size: 11.5px; color: #8a9099; }
		.notes { width: 100%; background: #1a1d23; color: #e6e6e6; border: 1px solid #2a2f37; border-radius: 4px; padding: 8px 10px; font-family: inherit; font-size: 12.5px; resize: vertical; margin-top: 4px; }
		.dim { color: #6c727b; font-weight: normal; }
		/* Staging area: fixed bottom panel */
		.staging { position: fixed; bottom: 0; left: 0; right: 0; background: #1a1d23; border-top: 2px solid #2a2f37; padding: 10px 24px; max-height: 30vh; overflow-y: auto; z-index: 200; }
		.staging-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
		.staging-header h2 { margin: 0; font-size: 13px; color: #e6e6e6; }
		.staging-header .hint { color: #6c727b; font-size: 11px; }
		.staging-items { display: flex; flex-wrap: wrap; gap: 8px; }
		.staging-items:empty::after { content: 'No staged observations. Click × on any obs to eject it here.'; color: #6c727b; font-size: 11.5px; font-style: italic; }
		.staging-item { background: #1f2329; border: 1px solid #2a2f37; border-radius: 4px; padding: 6px 10px; font-size: 11.5px; cursor: pointer; max-width: 280px; transition: all 0.15s; }
		.staging-item:hover { background: #262a32; }
		.staging-item.selected { background: #2a3a4a; border-color: #5a7fa6; color: #aaccef; }
		.staging-item .stitle { font-weight: 600; }
		.staging-item .sents { font-size: 10.5px; color: #8a9099; margin-top: 2px; }
		.staging-item .return-btn { float: right; margin-left: 8px; color: #6c727b; font-size: 10px; cursor: pointer; }
		.staging-item .return-btn:hover { color: #e0b97a; }
	</style>
</head>
<body>
	<header class="top">
		<h1>Belief clusters review</h1>
		<span class="stats" id="stats"></span>
		<input type="text" id="filter" placeholder="filter by anchor, title, entity…">
		<button id="export-btn">export state</button>
		<button id="clear-btn">clear all</button>
	</header>
	${clustersHtml}

	<aside class="staging">
		<div class="staging-header">
			<h2>Staging</h2>
			<span class="hint">click obs to select · click <b>+ add selected</b> on a cluster to move them · click ↩ to return obs to its original cluster</span>
			<span style="margin-left:auto;color:#8a9099;font-size:11px" id="staging-stats"></span>
		</div>
		<div class="staging-items" id="staging-items"></div>
	</aside>

	<script>
		const STORAGE_KEY = 'belief-clusters-v2-${WORKSPACE}';
		const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		if (!state.votes) state.votes = {};
		if (!state.notes) state.notes = {};
		if (!state.staged) state.staged = []; // [{obs_id, original_cluster_key}]
		if (!state.moves) state.moves = []; // [{obs_id, from, to, at}]
		if (!state.selected) state.selected = []; // ids in staging that are selected

		const obsData = ${JSON.stringify(
			Object.fromEntries(
				observations.map((o) => [
					o.id,
					{
						title: o.title,
						summary: o.summary,
						pos: o.pos.map((e) => ({ kind: e.kind, name: e.name }))
					}
				])
			)
		)};

		function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); updateStats(); }

		function updateStats() {
			const total = document.querySelectorAll('.cluster').length;
			const good = Object.values(state.votes).filter((v) => v === 'good').length;
			const bad = Object.values(state.votes).filter((v) => v === 'bad').length;
			document.getElementById('stats').textContent =
				good + ' good · ' + bad + ' bad · ' + (total - good - bad) + ' pending · ' + state.moves.length + ' obs moved · ' + state.staged.length + ' staged';
			document.getElementById('staging-stats').textContent = state.staged.length + ' obs · ' + state.selected.length + ' selected';
		}

		function applyState() {
			document.querySelectorAll('.cluster').forEach((sec) => {
				const key = sec.dataset.clusterKey;
				const v = state.votes[key];
				sec.classList.toggle('c-good', v === 'good');
				sec.classList.toggle('c-bad', v === 'bad');
				sec.querySelectorAll('.v-good').forEach((b) => b.classList.toggle('active', v === 'good'));
				sec.querySelectorAll('.v-bad').forEach((b) => b.classList.toggle('active', v === 'bad'));
				const ta = sec.querySelector('.notes');
				if (ta) ta.value = state.notes[key] || '';
			});
			// Ejected obs visual
			const stagedIds = new Set(state.staged.map((s) => s.obs_id));
			document.querySelectorAll('.obs').forEach((el) => {
				el.classList.toggle('ejected', stagedIds.has(el.dataset.obsId));
			});
			renderStaging();
			updateClusterCounts();
			updateStats();
		}

		function updateClusterCounts() {
			document.querySelectorAll('.cluster').forEach((sec) => {
				const visible = [...sec.querySelectorAll('.obs')].filter((o) => !o.classList.contains('ejected'));
				const span = sec.querySelector('[data-count]');
				if (span) span.textContent = visible.length + ' obs';
				const btn = sec.querySelector('.add-staged-btn');
				if (btn) btn.disabled = state.selected.length === 0;
			});
		}

		function renderStaging() {
			const container = document.getElementById('staging-items');
			container.innerHTML = '';
			for (const item of state.staged) {
				const d = obsData[item.obs_id];
				if (!d) continue;
				const div = document.createElement('div');
				div.className = 'staging-item' + (state.selected.includes(item.obs_id) ? ' selected' : '');
				div.dataset.obsId = item.obs_id;
				const ents = d.pos.map((e) => '<span class="pill ' + e.kind + '">' + e.kind + ': ' + escapeHtml(e.name) + '</span>').join(' ');
				div.innerHTML = '<span class="return-btn" title="return to original cluster">↩</span><div class="stitle">' + escapeHtml(d.title || '') + '</div><div class="sents">' + ents + '</div>';
				div.addEventListener('click', (e) => {
					if (e.target.classList.contains('return-btn')) {
						// Return to original cluster — physically un-eject in place
						const idx = state.staged.findIndex((s) => s.obs_id === item.obs_id);
						if (idx >= 0) state.staged.splice(idx, 1);
						state.selected = state.selected.filter((id) => id !== item.obs_id);
						const obsEl = document.querySelector('.obs[data-obs-id="' + CSS.escape(item.obs_id) + '"]');
						if (obsEl) obsEl.classList.remove('ejected');
						persist(); applyState();
						return;
					}
					const idx = state.selected.indexOf(item.obs_id);
					if (idx >= 0) state.selected.splice(idx, 1);
					else state.selected.push(item.obs_id);
					persist(); applyState();
				});
				container.appendChild(div);
			}
		}

		function escapeHtml(s) {
			return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
		}

		// Eject button
		document.querySelectorAll('.eject-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				const obsId = btn.dataset.obsId;
				const cluster = btn.closest('.cluster').dataset.clusterKey;
				if (!state.staged.find((s) => s.obs_id === obsId)) {
					state.staged.push({ obs_id: obsId, original_cluster_key: cluster });
				}
				persist(); applyState();
			});
		});

		// Add staged to cluster — physically move the obs DOM element into the
		// target cluster's obs container so the visual reflects the move.
		document.querySelectorAll('.add-staged-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				if (state.selected.length === 0) return;
				const targetKey = btn.dataset.clusterKey;
				const targetContainer = document.querySelector('[data-cluster-obs-container="' + CSS.escape(targetKey) + '"]');
				if (!targetContainer) { console.warn('no target container for', targetKey); return; }
				for (const obsId of state.selected) {
					const idx = state.staged.findIndex((s) => s.obs_id === obsId);
					if (idx < 0) continue;
					const original = state.staged[idx].original_cluster_key;
					state.moves.push({ obs_id: obsId, from: original, to: targetKey, at: new Date().toISOString() });
					state.staged.splice(idx, 1);
					// Move the DOM element
					const obsEl = document.querySelector('.obs[data-obs-id="' + CSS.escape(obsId) + '"]');
					if (obsEl) {
						obsEl.classList.remove('ejected');
						targetContainer.appendChild(obsEl);
					}
				}
				state.selected = [];
				persist(); applyState();
			});
		});

		// Return-to-original (↩) button in staging — physically move back too.
		// (The click handler is built in renderStaging; we handle the DOM move
		// inside that handler when the return button is clicked.)

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
			alert('State copied to clipboard.');
		});

		document.getElementById('clear-btn').addEventListener('click', () => {
			if (confirm('Clear all votes, notes, moves, and staging?')) {
				localStorage.removeItem(STORAGE_KEY);
				location.reload();
			}
		});

		const filterEl = document.getElementById('filter');
		filterEl.addEventListener('input', () => {
			const q = filterEl.value.trim().toLowerCase();
			document.querySelectorAll('.cluster').forEach((sec) => {
				const text = sec.textContent.toLowerCase();
				sec.style.display = !q || text.includes(q) ? '' : 'none';
			});
		});

		applyState();
	</script>
</body>
</html>`;

const outPath = path.join(AGENT_ROOT, 'evals', 'memory-graph', 'belief-clusters-review.html');
await fs.writeFile(outPath, html, 'utf8');
console.log(`Wrote ${outPath} (${clusters.length} clusters · ${observations.length} obs)`);
console.log(`Open: file://${outPath}`);
