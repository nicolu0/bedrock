// Belief-former — consolidates a fresh observation into beliefs, anchored
// by entities (vendor / property / owner).
//
// Pipeline:
//   1. Resolve every named entity in the observation (find-or-create rows in
//      the entities table). This is the single biggest change vs. the old
//      vector-only retrieval: when an observation about Kori comes in, we
//      now have an entity_id for Kori we can FK-search against.
//   2. Candidate retrieval is entity-first: pull every belief that shares an
//      entity with this observation. Vector recall is a fallback for cases
//      where no entity overlap exists.
//   3. LLM decides: attach (with weight), create (with claim + entities[]),
//      or noop. Strong attach bias when the entity-set overlaps.
//   4. Apply ops — attach via belief_evidence + confidence delta, create via
//      memory.createBelief + attachEntityEdges.
//
// Concurrency: serialized per workspace via an in-process Promise chain.

import * as memory from './memory.mjs';
import * as entities from './entities.mjs';

const MODEL = process.env.BELIEF_FORMER_MODEL || 'gpt-5.4-2026-03-05';

// Confidence math (per design doc).
const DECAY = 0.95;
const GAIN = 0.15;
const PENALTY = 0.2;

const CONTEXT_OBS_K = 5;
const FALLBACK_BELIEF_K = 5;
const ENTITY_BELIEF_LIMIT = 20;

// Kinds we promote to entity nodes in v1. The observation extractor may emit
// other kinds (person, system_component, etc.) — those stay in
// observation.entities jsonb but don't become entity rows.
const ENTITY_KINDS = new Set(['vendor', 'property', 'owner']);

// In-process per-workspace serializer.
const workspaceQueues = new Map();

export function runBeliefFormer(workspace_id, observation_id) {
	const prev = workspaceQueues.get(workspace_id) ?? Promise.resolve();
	const next = prev.then(() => consolidate(workspace_id, observation_id)).catch((err) => {
		console.error(
			`belief-former error (workspace=${workspace_id}, obs=${observation_id}):`,
			err
		);
		return { ops: [], error: err.message };
	});
	workspaceQueues.set(workspace_id, next.catch(() => {}));
	return next;
}

async function consolidate(workspace_id, observation_id) {
	const obs = await fetchObservation(observation_id);
	if (!obs) return { ops: [], reason: 'observation not found' };

	// Step 1: resolve entities mentioned in the observation.
	const observationEntities = await resolveObservationEntities(workspace_id, obs);

	// Step 2: candidate retrieval. Entity-anchored first; vector fallback.
	const candidateBeliefs = await collectCandidates({
		workspace_id,
		observation: obs,
		observationEntities
	});

	// Context observations (raw similar past observations, for LLM context only).
	const similarObs = await memory
		.recallObservations(workspace_id, { query: obs.summary, top_k: CONTEXT_OBS_K })
		.catch(() => []);

	const ops = await classifyWithLLM({
		observation: obs,
		observationEntities,
		similarObservations: (similarObs ?? []).filter((o) => o.id !== obs.id),
		candidateBeliefs
	});

	const applied = [];
	for (const op of ops) {
		try {
			const result = await applyOp({
				workspace_id,
				observation: obs,
				op,
				candidateBeliefs,
				observationEntities
			});
			if (result) applied.push(result);
		} catch (err) {
			console.error('belief-former applyOp error:', err, op);
		}
	}
	return { ops: applied };
}

// ── entity resolution from observation ──────────────────────────────────────

// Post-PR2: observation entities are stored in the observation_entities join
// (with signed weight). Read them directly from the join rather than walking
// the legacy jsonb shape. Returns entity rows with a `_weight` field carrying
// the chosen/rejected role.
async function resolveObservationEntities(workspace_id, obs) {
	const { supabaseEnv } = await import('./supabase.mjs');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'weight,entity:entities(id,kind,name,ref_id)',
		observation_id: `eq.${obs.id}`
	});
	const res = await fetch(`${url}/rest/v1/observation_entities?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) {
		console.error(`belief-former: fetch observation_entities ${res.status} ${await res.text()}`);
		return [];
	}
	const rows = await res.json();
	return rows
		.map((r) => (r.entity ? { ...r.entity, _weight: r.weight ?? 1 } : null))
		.filter(Boolean)
		.filter((e) => ENTITY_KINDS.has(e.kind));
}

// ── candidate retrieval ─────────────────────────────────────────────────────

async function collectCandidates({ workspace_id, observation, observationEntities }) {
	const byId = new Map();

	// Entity-anchored: every belief that shares an entity with this observation.
	for (const ent of observationEntities) {
		const beliefs = await entities
			.recallEntityBeliefs(ent.id, { limit: ENTITY_BELIEF_LIMIT })
			.catch((err) => {
				console.error(`recallEntityBeliefs(${ent.id}) failed:`, err.message);
				return [];
			});
		for (const b of beliefs) {
			if (!byId.has(b.id)) {
				byId.set(b.id, { ...b, _matched_via: 'entity', _matched_entities: [ent.id] });
			} else {
				byId.get(b.id)._matched_entities.push(ent.id);
			}
		}
	}

	// Vector fallback when entity-anchored found nothing (or as a small extra
	// signal). Tagged so the LLM knows these are looser matches.
	if (byId.size < FALLBACK_BELIEF_K) {
		const vec = await memory
			.recallBeliefs(workspace_id, { query: observation.summary, top_k: FALLBACK_BELIEF_K })
			.catch(() => []);
		for (const b of vec ?? []) {
			if (!byId.has(b.id)) {
				byId.set(b.id, { ...b, _matched_via: 'vector', similarity: b.similarity });
			}
		}
	}

	// Enrich each candidate with its current entity-set so the LLM can compare.
	const candidates = [...byId.values()];
	for (const c of candidates) {
		c._entities = await fetchBeliefEntities(c.id).catch(() => []);
	}
	return candidates;
}

async function fetchBeliefEntities(belief_id) {
	const { supabaseEnv } = await import('./supabase.mjs');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'entity:entities(id,kind,name)',
		belief_id: `eq.${belief_id}`
	});
	const res = await fetch(`${url}/rest/v1/belief_entities?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) return [];
	const rows = await res.json();
	return rows.map((r) => r.entity).filter(Boolean);
}

// ── LLM classification ──────────────────────────────────────────────────────

const OPS_SCHEMA = {
	name: 'belief_former_ops',
	strict: false,
	schema: {
		type: 'object',
		additionalProperties: false,
		required: ['ops'],
		properties: {
			ops: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['action', 'reason'],
					properties: {
						action: { type: 'string', enum: ['attach', 'create', 'noop'] },
						belief_id: {
							type: ['string', 'null'],
							description: 'Required when action=attach. id from the candidate beliefs list.'
						},
						weight: {
							type: ['number', 'null'],
							description:
								'Required when action=attach. Signed magnitude 0..1 (positive=supports, negative=contradicts).'
						},
						claim: {
							type: ['string', 'null'],
							description:
								'Required when action=create. Short self-contained sentence ("Kori is handyman for Harrison Properties").'
						},
						scope: {
							type: ['object', 'null'],
							description:
								'Optional taxonomy axes that AREN\'T named entities (trade, problem_subtype, urgency).',
							additionalProperties: true
						},
						explicitness: {
							type: ['string', 'null'],
							enum: ['stated', 'inferred', null]
						},
						entities: {
							type: ['array', 'null'],
							description:
								'Entities this belief is about. For action=create, list them; for action=attach, optionally add NEW entities the candidate is missing.',
							items: {
								type: 'object',
								additionalProperties: false,
								required: ['kind', 'name'],
								properties: {
									kind: { type: 'string', enum: ['vendor', 'property', 'owner'] },
									name: { type: 'string' }
								}
							}
						},
						tags: {
							type: ['array', 'null'],
							items: { type: 'string' }
						},
						reason: {
							type: 'string',
							description: 'One sentence justifying this op. For logs.'
						}
					}
				}
			}
		}
	}
};

const SYSTEM_PROMPT = `You are an apprentice at a property management company. Right now your role is an assistant to the property manager — the user you talk to. You must learn as much as you can and transfer all of their knowledge to yourself. Your goal is to learn the inner workings of this company so you can take over all operations and run this company by yourself. This memory graph is literally your brain — you must cherish it and maintain it well. You collect observations from interacting with the PM and build BELIEFS over time. Be extremely diligent. Every single lazy decision you make will compound into huge flaws in decision-making later on.

Your job NOW: given ONE new observation and a list of candidate beliefs, decide what belief operations to apply. A belief is a durable, rule-like NOTE you memorize. The agent will retrieve beliefs to make routing decisions later, so each belief should read like a fact or standard.

# THE GENERALIZATION MANDATE (read first, apply throughout)

Beliefs are the PRIMARY retrieval surface for future decisions. Observations are the FALLBACK — they exist only to support beliefs that don't yet stand on their own. Your goal is to make every belief AS GENERAL AS POSSIBLE while still being plausibly correct.

Generalization order (broadest → narrowest):
  1. Vendor-wide: "X handles Y issues" (no property/owner scope)
  2. Owner-scoped: "X handles Y at Owner properties"
  3. Property-scoped: "X handles Y at specific property"
  4. Issue-specific or one-off: usually NOT a belief at all — leave as obs evidence

When picking scope, push UP one level if it's plausibly correct. "Kori at 50 Rose" + "Kori at 17 Ozone" + "Kori at 15 Ozone" → owner-scoped "Kori at Harrison Properties" — NOT three property-scoped beliefs. "Osalpa at 829 OP" + "Osalpa at 1520 OP" → vendor-wide "Osalpa handles electrical" — NOT two property-scoped beliefs.

If you find yourself creating two beliefs about the SAME vendor where only the property differs, STOP — generalize upward instead.

# BELIEF SHAPE & STYLE

A belief is a SHORT, SELF-CONTAINED RULE-LIKE CLAIM anchored to one or more entities (vendor / property / owner).

Good examples:
  ✓ "Yonic Herrera handles all plumbing issues — drains, garbage disposals, water heaters, faucets, complex repairs."
  ✓ "Abraham Monroy handles general handyman issues AND simple plumbing (toilet basics, slow drains, doorknobs, blinds)."
  ✓ "Kori Anderson handles all maintenance (handyman + simple plumbing + electrical) at Harrison Properties."
  ✓ "Solomon Grauzinis Trust requires owner approval before vendor dispatch for all issues."
  ✓ "Tre Elevators services elevators at 6337 Primrose Ave (under contract)."
  ✓ "Jimenez Services is the primary vendor for gates."
  ✓ "Unit 14 tenant at 221-229 Union Pl is the onsite manager; route property-level questions through them."

Bad examples:
  ✗ "X has property-management quirk" — vague filler. NEVER write this.
  ✗ "Kori at Glencoe handyman" + "Kori at Rose handyman" + "Kori at Ozone handyman" — three property-scoped beliefs when ONE owner-scoped belief covers them all.
  ✗ "X handled Y on date Z" — that's an observation, not a belief.

# DESIGN RULES (must obey)

1. **OWNER-SCOPED > PROPERTY-SCOPED.** When a vendor has obs at multiple properties owned by the SAME owner, write the belief at OWNER scope. Use the owner entity in entities[]. Example: Kori at Harrison Properties (not Kori at Glencoe + Kori at Rose).

2. **CLAIM = RULE-LIKE STATEMENT.** Belief claims read like memos or standards — "X handles Y", "X requires Y before Z", "For Y, use X". Never "X has quirk Y" or "X did Y once".

3. **MULTIPLE BELIEFS PER VENDOR ARE FINE.** Don't merge a vendor's capabilities into one giant claim. Better as separate retrievable beliefs:
   - "Cross Appliance handles appliances" (one belief)
   - "Cross Appliance was rejected by Grauzinis owner for oven repair" (separate belief if it matters)

4. **DOMAIN ASSIGNMENT:**
   - Garbage disposals = PLUMBING (not appliance). Route to Yonic/Abraham, not Cross.
   - Fridge / dishwasher / ice maker / dryer / range = appliance → Cross Appliance.
   - Status updates ("issue fixed") → NOOP — they're not beliefs.

5. **VENDOR LIFECYCLE EVENTS → NOOP.** Vendor retirement (Darwin), new vendor added (new Juan) are admin actions, not beliefs. NOOP.

6. **SINGLE-OBS BELIEFS ONLY WITH STATED RULE LANGUAGE.** Create from one obs only when:
   - PM stated a rule explicitly ("Yonic is more experienced plumber").
   - PM asked you to remember it ("Primerose has contract with Tre elevators").
   - It's a vendor exclusion ("don't use Darwin").
   - It's an owner approval policy ("Grauzinis requires approval").
   - Property-specific ownership exception ("we don't own the laundry machines at Westmoreland").
   Otherwise: NOOP (just store the obs as evidence — no belief).

7. **JOSE = JL.** Don't write "Jose self-handled X via JL" — Jose IS JL. Just "Jose self-handled X" or "JL handled X". Don't append "at properties he manages directly" — he's PM for ALL properties.

# OPERATIONS

- **attach**: this observation supports (positive weight) or contradicts (negative weight) an existing candidate belief. Use this when entity overlap + similar claim already exists.
- **create**: a brand-new belief. Only when (entity-set + claim direction) is genuinely new and the design rules say emit.
- **noop**: redundant / lifecycle / status / weak single-obs / not load-bearing. Pick this LIBERALLY — belief noise compounds.

# DECISION PRIORITY (top-down)

1. If candidate belief's entity-set OVERLAPS with this observation AND has a similar claim direction → ATTACH. Don't duplicate.
2. STRONGLY prefer attach. Reinforcing a belief is better than creating a near-duplicate.
3. Create only when claim is genuinely new (different entity-set OR different rule direction).
4. NOOP when: status confirmations, vendor lifecycle admin, weak single-obs without stated rule, or just routine evidence for an existing belief.
5. Emit AT MOST 2 ops per observation. Secondary claims wait for their own observations.

# WEIGHT & EXPLICITNESS

- weight 0.8–1.0 for direct PM statements (stated rules, explicit preferences, "remember this").
- weight 0.4–0.6 for inferred from behavior (pattern observed).
- NEGATIVE weight for contradictions ("the rejected vendor / wrong choice" signal).
- explicitness=stated when PM said it directly; explicitness=inferred for behavior-pattern beliefs.

Output JSON matching the schema. No prose.`;

async function classifyWithLLM({
	observation,
	observationEntities,
	similarObservations,
	candidateBeliefs
}) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('belief-former: OPENAI_API_KEY not set');

	const userMessage = formatPrompt({
		observation,
		observationEntities,
		similarObservations,
		candidateBeliefs
	});

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: userMessage }
			],
			response_format: { type: 'json_schema', json_schema: OPS_SCHEMA },
			temperature: 0
		})
	});
	if (!res.ok) throw new Error(`belief-former LLM: ${res.status} ${await res.text()}`);
	const body = await res.json();
	const content = body?.choices?.[0]?.message?.content;
	if (!content) return [];
	try {
		const parsed = JSON.parse(content);
		return Array.isArray(parsed?.ops) ? parsed.ops : [];
	} catch (err) {
		console.error('belief-former: failed to parse LLM JSON:', err, content);
		return [];
	}
}

function formatEntityRef(e) {
	return `${e.kind}:${e.name}`;
}

function formatObsEntityRef(e) {
	const weightTag = e._weight === undefined || e._weight === 1
		? ''
		: e._weight < 0
			? ` (REJECTED, w=${e._weight.toFixed(1)})`
			: ` (w=${e._weight.toFixed(1)})`;
	return `${e.kind}:${e.name}${weightTag}`;
}

function formatPrompt({
	observation,
	observationEntities,
	similarObservations,
	candidateBeliefs
}) {
	const obsEntityLine = observationEntities.length
		? observationEntities.map((e) => `[${e.id.slice(0, 8)}] ${formatObsEntityRef(e)}`).join(', ')
		: '(none)';

	const obsBlock = [
		`# new observation`,
		`id: ${observation.id}`,
		observation.title ? `title: ${observation.title}` : null,
		`summary: ${observation.summary}`,
		observation.raw_text ? `source_quote: "${observation.raw_text}"` : null,
		`tags: ${(observation.tags ?? []).join(', ') || '(none)'}`,
		`entities (with weight): ${obsEntityLine}`,
		`salience: ${observation.salience}`
	]
		.filter(Boolean)
		.join('\n');

	const obsContext = similarObservations.length
		? similarObservations
				.map(
					(o) =>
						`- [${o.id}] (sim=${(o.similarity ?? 0).toFixed(2)}, sal=${o.salience}) ${o.summary}`
				)
				.join('\n')
		: '(none)';

	const beliefContext = candidateBeliefs.length
		? candidateBeliefs
				.map((b) => {
					const entStr = (b._entities ?? []).map(formatEntityRef).join(', ') || '(no entities)';
					const matchTag =
						b._matched_via === 'entity'
							? `via entity ${b._matched_entities.length === 1 ? '' : `×${b._matched_entities.length} `}`
							: `via vector (sim=${(b.similarity ?? 0).toFixed(2)})`;
					return `- [${b.id}] (${matchTag}, conf=${b.confidence.toFixed(2)}, ${b.explicitness}, by=${b.created_by})\n    claim: "${b.claim}"\n    entities: ${entStr}\n    scope: ${JSON.stringify(b.scope ?? {})}`;
				})
				.join('\n')
		: '(no candidate beliefs)';

	return `${obsBlock}

# similar past observations (context only — do not create beliefs about them)
${obsContext}

# candidate beliefs (the only ids you may use for action=attach)
${beliefContext}

Emit a JSON object with field "ops" matching the schema. Strongly prefer attach when entity-sets overlap.`;
}

// ── op application ──────────────────────────────────────────────────────────

async function applyOp({
	workspace_id,
	observation,
	op,
	candidateBeliefs,
	observationEntities
}) {
	if (op.action === 'noop') return { action: 'noop', reason: op.reason };

	if (op.action === 'attach') {
		if (!op.belief_id || typeof op.weight !== 'number') {
			throw new Error(`attach op missing belief_id/weight: ${JSON.stringify(op)}`);
		}
		const belief = candidateBeliefs.find((b) => b.id === op.belief_id);
		if (!belief) throw new Error(`attach op references unknown belief_id ${op.belief_id}`);

		await memory.attachEvidence(belief.id, observation.id, op.weight);
		const nextConf = applyConfidenceDelta(belief.confidence, op.weight, observation.salience);
		await memory.updateBelief(belief.id, { confidence: nextConf });

		// Optionally enrich the belief with any new entities the LLM emitted.
		let extraEdges = 0;
		if (Array.isArray(op.entities) && op.entities.length) {
			const ids = [];
			for (const e of op.entities) {
				if (!ENTITY_KINDS.has(e.kind)) continue;
				const resolved = await entities.resolveEntity({
					workspace_id,
					kind: e.kind,
					name: e.name
				});
				ids.push(resolved.id);
			}
			extraEdges = await entities.attachEntityEdges(belief.id, ids);
		}

		return {
			action: 'attach',
			belief_id: belief.id,
			weight: op.weight,
			confidence_before: belief.confidence,
			confidence_after: nextConf,
			extra_edges: extraEdges,
			reason: op.reason
		};
	}

	if (op.action === 'create') {
		if (!op.claim || !op.explicitness) {
			throw new Error(`create op missing claim/explicitness: ${JSON.stringify(op)}`);
		}
		const initial = clamp01(
			observation.salience * (op.explicitness === 'stated' ? 0.8 : 0.5)
		);
		const belief = await memory.createBelief(workspace_id, {
			claim: op.claim,
			scope: op.scope ?? {},
			confidence: initial,
			explicitness: op.explicitness,
			created_by: 'agent',
			tags: op.tags ?? []
		});
		await memory.attachEvidence(belief.id, observation.id, 1.0);

		// Resolve and attach entity edges. Prefer the LLM-emitted entities; fall
		// back to the observation's resolved entities if the LLM didn't emit any.
		const edgeIds = [];
		const emitted = Array.isArray(op.entities) && op.entities.length
			? op.entities
			: observationEntities.map((e) => ({ kind: e.kind, name: e.name }));
		for (const e of emitted) {
			if (!ENTITY_KINDS.has(e.kind)) continue;
			const resolved = await entities.resolveEntity({
				workspace_id,
				kind: e.kind,
				name: e.name
			});
			edgeIds.push(resolved.id);
		}
		const edges = await entities.attachEntityEdges(belief.id, edgeIds);

		return {
			action: 'create',
			belief_id: belief.id,
			claim: op.claim,
			confidence: initial,
			entity_edges: edges,
			reason: op.reason
		};
	}

	throw new Error(`unknown op action: ${op.action}`);
}

function applyConfidenceDelta(old_confidence, weight, salience) {
	const sign = weight >= 0 ? 1 : -1;
	const factor = sign > 0 ? GAIN : PENALTY;
	const delta = Math.abs(weight) * salience * factor * sign;
	return clamp01(old_confidence * DECAY + delta);
}

function clamp01(x) {
	if (!Number.isFinite(x)) return 0;
	if (x < 0) return 0;
	if (x > 1) return 1;
	return x;
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function fetchObservation(id) {
	const { supabaseEnv } = await import('./supabase.mjs');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,workspace_id,title,summary,raw_text,entities,salience,tags,source_message_id',
		id: `eq.${id}`,
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/observations?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`fetchObservation: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows[0] ?? null;
}
