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

// observation.entities is jsonb shaped like { vendor: ["Yonic"], property: ["Pickford"], person: ["Jose"], ... }.
// Flatten to [(kind, name)], filter to v1 kinds, resolve each to an entity row.
async function resolveObservationEntities(workspace_id, obs) {
	const e = obs.entities ?? {};
	const pairs = [];
	for (const [kind, value] of Object.entries(e)) {
		if (!ENTITY_KINDS.has(kind)) continue;
		const names = Array.isArray(value) ? value : [value];
		for (const name of names) {
			if (typeof name === 'string' && name.trim()) {
				pairs.push({ kind, name: name.trim() });
			}
		}
	}
	const resolved = [];
	for (const p of pairs) {
		try {
			const ent = await entities.resolveEntity({ workspace_id, kind: p.kind, name: p.name });
			resolved.push(ent);
		} catch (err) {
			console.error(`belief-former: resolveEntity(${p.kind}, ${p.name}) failed:`, err.message);
		}
	}
	return resolved;
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
	const { supabaseEnv } = await import('../supabase.mjs');
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

const SYSTEM_PROMPT = `You are the belief-former for an AI agent that runs property-management work orders.

A "belief" is a typed relationship between entities (vendor / property / owner) plus an optional taxonomy scope. Each belief is short and self-contained — examples:
  - "Kori is handyman for Harrison Properties"   entities=[vendor:Kori, owner:Harrison Properties]
  - "Yonic is the primary plumber"               entities=[vendor:Yonic]
  - "Tre Elevators services 6337 Primrose"      entities=[vendor:Tre Elevators, property:6337 Primrose]
  - "Solomon Grauzinis Trust requires owner approval before dispatch"   entities=[owner:Solomon Grauzinis Trust]
  - "Darwin is no longer used"                   entities=[vendor:Darwin]

A belief is identified by its (entity-set, claim). Two observations producing the SAME entity-set and similar claim must consolidate into ONE belief via attach — never create duplicates.

You will receive:
- ONE new observation, including the entities already resolved from it.
- Similar past observations (context only — do NOT create beliefs about them).
- Candidate beliefs, each tagged with how it was matched (entity = shares an entity with the new observation; vector = looser semantic match) and its current entity-set.

Operations:
  - attach: this observation supports (positive weight) or contradicts (negative weight) a candidate belief. Optionally add new entities to that belief.
  - create: a brand-new relationship not covered by any candidate. Provide claim, entities, explicitness.
  - noop: redundant, noisy, or not load-bearing.

Decision priority (top-down):
  1. If a candidate belief has an OVERLAPPING entity-set with this observation AND a similar claim direction → ATTACH. Don't create a new belief for "Kori at Glencoe" when "Kori at Harrison Properties" already exists.
  2. STRONGLY prefer attach. If you find yourself about to create a belief whose entities are already in a candidate, attach instead.
  3. Create only when the (entity-set, claim) is genuinely new. Different entity-set is the strongest signal.
  4. Emit AT MOST 2 ops per observation. Secondary claims wait for their own observations.

Claim writing rules:
  - Short and self-contained. "Kori is handyman for Harrison Properties" — not "Use Kori for handyman work at Harrison Properties (Rose, Glencoe, Ozone)."
  - Refer to entities by their names (the entity-set carries the structural link).
  - Don't pile multiple unrelated claims into one belief.

Scope:
  - Only for taxonomy axes that AREN'T named entities: trade ("plumbing", "handyman", "electrical"), problem_subtype, urgency_tier, etc. Most beliefs need none.

Weight & explicitness:
  - 0.8–1.0 for direct PM statements, 0.3–0.5 for inferred-from-behavior. Negative for contradictions.
  - explicitness=stated when the PM said it directly; inferred for behavior-pattern beliefs.

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

function formatPrompt({
	observation,
	observationEntities,
	similarObservations,
	candidateBeliefs
}) {
	const obsEntityLine = observationEntities.length
		? observationEntities.map((e) => `[${e.id.slice(0, 8)}] ${formatEntityRef(e)}`).join(', ')
		: '(none of kind vendor/property/owner)';

	const obsBlock = [
		`# new observation`,
		`id: ${observation.id}`,
		`summary: ${observation.summary}`,
		`salience: ${observation.salience}`,
		`resolved entities: ${obsEntityLine}`,
		`raw entities (incl. non-v1 kinds): ${JSON.stringify(observation.entities ?? {})}`,
		`tags: ${(observation.tags ?? []).join(', ') || '(none)'}`,
		observation.raw_text ? `raw_text: ${observation.raw_text}` : null
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
	const { supabaseEnv } = await import('../supabase.mjs');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,workspace_id,summary,raw_text,entities,salience,tags,source_message_id',
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
