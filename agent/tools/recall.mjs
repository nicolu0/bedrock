// recall — the agent's one entry point into the memory graph. Runs a hybrid
// retrieval over three tiers and returns ranked candidates with provenance:
//
//   1. STRUCTURAL — resolve entity hints (property, vendor) and walk
//      belief_entities / observation_entities joins. Property hints also
//      cascade up to their owner entities via owner_properties.
//   2. SEMANTIC — vector recall over beliefs (and observations if thin).
//   3. LEGACY — fall back to raw `vendors` / `owner_properties` rows when
//      memory has nothing for this query.
//
// The LLM provides whatever hints it knows: a natural-language `question`
// always, plus optional `property` / `vendor` / `issue` hints. Each candidate
// carries a `provenance` string the agent can quote when explaining its pick.

import * as memory from '../core/memory.mjs';
import { resolveEntity, cascadeOwners } from '../core/entities.mjs';

// Conservative trade extraction for the legacy fallback. Keywords are the
// substrings we look for in issue text. First match wins. If nothing matches
// we skip legacy vendor lookup — the agent can still surface what the memory
// graph has via semantic recall.
const TRADE_KEYWORDS = {
	plumbing: [
		'plumb',
		'leak',
		'drain',
		'faucet',
		'toilet',
		'sink',
		'water heater',
		'pipe',
		'shower'
	],
	electrical: ['electric', 'outlet', 'wiring', 'wire', 'breaker', 'fuse'],
	hvac: ['hvac', ' ac ', 'a/c', 'heating', 'cooling', 'furnace', 'thermostat', 'air conditioning'],
	appliance: [
		'appliance',
		'dryer',
		'washer',
		'fridge',
		'refrigerator',
		'oven',
		'stove',
		'dishwasher'
	],
	handyman: ['handyman', 'general repair']
};

function inferTrade(issueText) {
	if (!issueText) return null;
	const s = ' ' + String(issueText).toLowerCase() + ' ';
	for (const [trade, keys] of Object.entries(TRADE_KEYWORDS)) {
		for (const k of keys) if (s.includes(k)) return trade;
	}
	return null;
}

function tsToMillis(ts) {
	if (!ts) return 0;
	const t = Date.parse(ts);
	return Number.isNaN(t) ? 0 : t;
}

function recencyWeight(ts, halfLifeDays = 30) {
	const ageMs = Date.now() - tsToMillis(ts);
	if (ageMs <= 0) return 1;
	const days = ageMs / 86_400_000;
	return Math.pow(0.5, days / halfLifeDays);
}

function entityNameById(entities, id) {
	const e = entities.find((x) => x.id === id);
	return e ? `${e.kind}:${e.name}` : 'entity';
}

function shortDate(ts) {
	if (!ts) return 'unknown';
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return 'unknown';
	return d.toISOString().slice(0, 10);
}

async function tier1Structural(workspace_id, anchorEntities) {
	if (anchorEntities.length === 0) return { beliefs: [], observations: [] };
	const ids = anchorEntities.map((e) => e.id);
	const [beliefs, observations] = await Promise.all([
		memory.beliefsForEntities(workspace_id, ids, { limit: 30 }),
		memory.observationsForEntities(workspace_id, ids, { limit: 30 })
	]);
	return { beliefs, observations };
}

async function tier2Semantic(workspace_id, question) {
	// Floor 0 mirrors the existing recall_beliefs / recall_observations tools:
	// rely on vector ranking + top_k cap rather than a hard threshold. The
	// belief scorer downstream will penalize low-relevance matches.
	if (!question) return { beliefs: [], observations: [] };
	const [beliefs, observations] = await Promise.all([
		memory.recallBeliefs(workspace_id, { query: question, top_k: 8, similarity_floor: 0 }),
		memory.recallObservations(workspace_id, { query: question, top_k: 8, similarity_floor: 0 })
	]);
	return { beliefs: beliefs ?? [], observations: observations ?? [] };
}

async function tier3Legacy(workspace_id, { issueText, propertyEntity }) {
	const out = { vendors: [], owners: [] };
	const trade = inferTrade(issueText);
	if (trade) {
		out.vendors = await memory.legacyVendorsForTrade(workspace_id, trade, { limit: 5 });
		for (const v of out.vendors) v._trade_match = trade;
	}
	if (propertyEntity?.ref_id) {
		out.owners = await memory.legacyOwnerForProperty(workspace_id, propertyEntity.ref_id);
	}
	return out;
}

function rankBelief(b) {
	const conf = b.confidence ?? 0;
	const ev = (b.evidence_count ?? 0) + 1;
	return conf * Math.log2(1 + ev);
}

function rankObservation(o) {
	const sal = o.salience ?? 0.5;
	const w = Math.abs(o.weight ?? 1);
	return sal * w * recencyWeight(o.ts);
}

export const recall = {
	name: 'recall',
	description:
		'Look up what the memory graph knows about this conversation. Pass a natural-language `question` always; add optional `property`, `vendor`, and `issue` hints when known so the hybrid retrieval can anchor on the right entities. Returns ranked candidates with provenance strings — quote them when explaining a pick to the PM. Use this BEFORE drafting or routing; it replaces recall_beliefs and recall_observations.',
	parameters: {
		type: 'object',
		properties: {
			question: {
				type: 'string',
				description:
					'Natural-language description of what you need to remember, e.g. "who do we use for plumbing at 17 Ozone" or "have we used Yonic before".'
			},
			property: {
				type: 'string',
				description:
					'Property name if mentioned or relevant. Resolves to a property entity and cascades to owner entities for scoped belief recall.'
			},
			vendor: {
				type: 'string',
				description: 'Vendor name if the question is about a specific vendor.'
			},
			issue: {
				type: 'string',
				description:
					'Issue text or trade description if picking a vendor. Used for trade extraction in the legacy fallback.'
			}
		},
		required: ['question']
	},
	async run({ question, property = null, vendor = null, issue = null }, ctx) {
		if (process.env.BEDROCK_EVAL_MODE === '1') {
			return { candidates: [], resolved_entities: [], tiers_fired: [], note: 'eval mode' };
		}
		if (!ctx.workspace_id) throw new Error('recall: ctx.workspace_id required');
		if (!question) throw new Error('recall: question required');

		// ── Resolve entity hints ────────────────────────────────────────────
		const resolved = [];
		let propertyEntity = null;
		let cascadedOwners = [];
		if (property) {
			try {
				propertyEntity = await resolveEntity({
					workspace_id: ctx.workspace_id,
					kind: 'property',
					name: property
				});
				resolved.push(propertyEntity);
				if (propertyEntity?.ref_id) {
					cascadedOwners = await cascadeOwners(propertyEntity, ctx.workspace_id);
					for (const o of cascadedOwners) resolved.push(o);
				}
			} catch (err) {
				console.error(`recall: resolve property "${property}" failed: ${err.message}`);
			}
		}
		let vendorEntity = null;
		if (vendor) {
			try {
				vendorEntity = await resolveEntity({
					workspace_id: ctx.workspace_id,
					kind: 'vendor',
					name: vendor
				});
				resolved.push(vendorEntity);
			} catch (err) {
				console.error(`recall: resolve vendor "${vendor}" failed: ${err.message}`);
			}
		}

		const anchorEntities = resolved.filter(Boolean);

		// ── Run all three tiers in parallel ────────────────────────────────
		// Each tier returns whatever signal it has; the LLM reads provenance
		// and decides what's relevant. No gating — vector search nearly always
		// returns something, which used to suppress the legacy directory lookup
		// even when memory had no trade-relevant answer. Letting all three fire
		// gives the LLM the full picture; the code-side score is a sort hint,
		// not a verdict.
		const [t1, t2, t3] = await Promise.all([
			tier1Structural(ctx.workspace_id, anchorEntities),
			tier2Semantic(ctx.workspace_id, question),
			tier3Legacy(ctx.workspace_id, { issueText: issue, propertyEntity })
		]);

		// Dedupe semantic results that already appeared structurally
		const structuralBeliefIds = new Set(t1.beliefs.map((b) => b.id));
		const structuralObsIds = new Set(t1.observations.map((o) => o.id));
		const semBeliefs = t2.beliefs.filter((b) => !structuralBeliefIds.has(b.id));
		const semObservations = t2.observations.filter((o) => !structuralObsIds.has(o.id));

		// ── Build candidates with provenance ────────────────────────────────
		const candidates = [];

		for (const b of t1.beliefs) {
			const matched = b.matched_entity_ids
				.map((id) => entityNameById(anchorEntities, id))
				.join(', ');
			candidates.push({
				kind: 'belief',
				data: { id: b.id, claim: b.claim, scope: b.scope, tags: b.tags },
				via: 'structural',
				confidence: b.confidence ?? 0,
				score: rankBelief(b) + 1, // structural tier bonus
				provenance: `belief "${b.claim}" — matched via ${matched} (conf ${b.confidence?.toFixed(2)}, evidence ×${b.evidence_count})`
			});
		}

		for (const b of semBeliefs) {
			candidates.push({
				kind: 'belief',
				data: { id: b.id, claim: b.claim, scope: b.scope, tags: b.tags },
				via: 'semantic',
				confidence: b.confidence ?? 0,
				score: rankBelief(b),
				provenance: `belief "${b.claim}" — matched via vector recall on question (conf ${b.confidence?.toFixed(2)})`
			});
		}

		for (const o of t1.observations) {
			const matched = o.matched_entity_ids
				.map((id) => entityNameById(anchorEntities, id))
				.join(', ');
			candidates.push({
				kind: 'observation',
				data: { id: o.id, summary: o.summary, ts: o.ts, tags: o.tags },
				via: 'structural',
				confidence: o.salience ?? 0.5,
				score: rankObservation(o),
				provenance: `obs "${o.summary}" — ${matched}, ${shortDate(o.ts)}`
			});
		}

		for (const o of semObservations) {
			candidates.push({
				kind: 'observation',
				data: { id: o.id, summary: o.summary, ts: o.ts, tags: o.tags },
				via: 'semantic',
				confidence: o.salience ?? 0.5,
				score: rankObservation(o) * 0.8,
				provenance: `obs "${o.summary}" — vector match on question, ${shortDate(o.ts)}`
			});
		}

		for (const v of t3.vendors) {
			candidates.push({
				kind: 'vendor',
				data: { id: v.id, name: v.name, trade: v.trade, phone: v.phone },
				via: 'legacy',
				confidence: 0.3,
				score: 0.3,
				provenance: `legacy vendor ${v.name} (trade=${v.trade}) — no memory yet, surfaced from PMS vendor list via trade match "${v._trade_match}"`
			});
		}

		for (const o of t3.owners) {
			candidates.push({
				kind: 'owner',
				data: { id: o.id, name: o.name },
				via: 'legacy',
				confidence: 0.3,
				score: 0.2,
				provenance: `legacy owner ${o.name} — memory has nothing for this property yet`
			});
		}

		candidates.sort((a, b) => b.score - a.score);

		// Summarize which tiers contributed so the LLM knows what to expect.
		const tiers_fired = [];
		if (t1.beliefs.length || t1.observations.length) tiers_fired.push('structural');
		if (semBeliefs.length || semObservations.length) tiers_fired.push('semantic');
		if (t3.vendors.length || t3.owners.length) tiers_fired.push('legacy');

		return {
			candidates,
			resolved_entities: resolved.map((e) => ({ kind: e.kind, name: e.name, id: e.id })),
			tiers_fired,
			note: 'Candidates are sorted by a coarse heuristic score. Read each provenance string and pick what actually fits the question — top-1 is not always the right answer.'
		};
	}
};
