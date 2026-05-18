// Belief-former — consolidates a fresh observation into beliefs.
//
// On each new observation:
//   1. vector-fetch the top-K similar past observations (for LLM context) and
//      top-K similar existing beliefs (the candidates we might attach to)
//   2. ask a mini LLM for a list of operations: attach (supporting or
//      contradicting an existing belief), create (new belief), noop
//   3. apply ops with the deterministic confidence formula (math is fixed,
//      classification is LLM)
//
// Concurrency: serialized per workspace via an in-process Promise chain.
// One PM per workspace today — pg advisory locks if we see contention later.

import * as memory from './memory.mjs';

const MODEL = process.env.BELIEF_FORMER_MODEL || 'gpt-5.4-2026-03-05';

// Confidence math (per design doc):
//   new = clamp(0, 1, old*decay  +  weight*salience*gain  - weight*salience*penalty)
// We store the sign on weight (positive=supports, negative=contradicts), so
// the formula collapses to a single signed delta and the penalty/gain split
// is just abs(weight) * (sign>0 ? gain : penalty).
const DECAY = 0.95;
const GAIN = 0.15;
const PENALTY = 0.2;

const SUPPORTING_K = 5;
const CONTEXT_K = 5;

// In-process per-workspace serializer. Back-to-back observations on the same
// workspace_id queue rather than racing the LLM and confidence updates.
const workspaceQueues = new Map();

export function runBeliefFormer(workspace_id, observation_id) {
	const prev = workspaceQueues.get(workspace_id) ?? Promise.resolve();
	const next = prev.then(() => consolidate(workspace_id, observation_id)).catch((err) => {
		// Don't poison the queue for the next observation.
		console.error(`belief-former error (workspace=${workspace_id}, obs=${observation_id}):`, err);
		return { ops: [], error: err.message };
	});
	workspaceQueues.set(workspace_id, next.catch(() => {}));
	return next;
}

async function consolidate(workspace_id, observation_id) {
	const obs = await fetchObservation(observation_id);
	if (!obs) return { ops: [], reason: 'observation not found' };

	const [similarObs, candidateBeliefs] = await Promise.all([
		memory.recallObservations(workspace_id, { query: obs.summary, top_k: CONTEXT_K }),
		memory.recallBeliefs(workspace_id, { query: obs.summary, top_k: SUPPORTING_K })
	]);

	const ops = await classifyWithLLM({
		observation: obs,
		similarObservations: similarObs.filter((o) => o.id !== obs.id),
		candidateBeliefs
	});

	const applied = [];
	for (const op of ops) {
		try {
			const result = await applyOp({ workspace_id, observation: obs, op, candidateBeliefs });
			if (result) applied.push(result);
		} catch (err) {
			console.error(`belief-former applyOp error:`, err, op);
		}
	}
	return { ops: applied };
}

// ── LLM classification ───────────────────────────────────────────────────────

// Note: strict: false intentionally. Strict mode requires
// additionalProperties: false on every object type, which breaks our scope
// JSON (intentionally free-form: any subset of trade/property/portfolio/...).
// Without strict, the schema is a guide; we parse the response defensively.
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
								'Required when action=attach. Signed: positive supports the belief, negative contradicts. Magnitude 0..1 (how directly this observation bears on the claim).'
						},
						claim: {
							type: ['string', 'null'],
							description: 'Required when action=create. The new belief text.'
						},
						scope: {
							type: ['object', 'null'],
							description:
								'Required when action=create. Pinned scope (subset of property_id/unit_id/trade/portfolio/problem_subtype/...).',
							additionalProperties: true
						},
						explicitness: {
							type: ['string', 'null'],
							enum: ['stated', 'inferred', null],
							description:
								'Required when action=create. "stated" if the PM said it directly, "inferred" if you are pattern-matching from behavior.'
						},
						tags: {
							type: ['array', 'null'],
							items: { type: 'string' }
						},
						reason: {
							type: 'string',
							description: 'One sentence justifying this op. Goes into logs, not into memory.'
						}
					}
				}
			}
		}
	}
};

const SYSTEM_PROMPT = `You are the belief-former for an AI agent that runs property-management work orders.

You receive ONE new observation (a PM signal we just recorded) plus context: similar past observations and the existing beliefs we already hold. Your job is to decide how this new observation should update our belief set.

Output a list of operations. Each operation is one of:
  - attach: this observation supports (positive weight) or contradicts (negative weight) an existing belief from the candidate list. Use the belief's id verbatim.
  - create: this observation reveals a NEW belief we did not hold yet. Provide claim, scope, explicitness, optional tags.
  - noop: this observation is too noisy, redundant with an existing belief that is already well-evidenced, or not load-bearing.

Rules:
  - Prefer attach over create if a candidate belief covers the same scope. Only create when the scope or claim is genuinely new.
  - Weight magnitude reflects how directly the observation bears on the claim. A direct statement: 0.8-1.0. An indirect signal (e.g. the PM picked the vendor without commenting): 0.3-0.5.
  - Use negative weight for contradictions: the PM dispatching someone else, or correcting a prior preference.
  - You can emit multiple ops if the observation supports one belief AND contradicts another, or supports a belief AND reveals an unrelated new one.
  - Scope is multi-axis JSON. Pin any subset of property_id, unit_id, trade, problem_subtype, portfolio. "Cory for shower clogs at 829 Ocean Park" and "Yonic for complex plumbing at 829 Ocean Park" do NOT conflict; they are two beliefs with different problem_subtype scopes.
  - explicitness=stated when the PM said it directly. explicitness=inferred when you are pattern-matching from behavior (e.g. they have dispatched Vendor X for trade Y three times).

Output JSON matching the provided schema. No prose.`;

async function classifyWithLLM({ observation, similarObservations, candidateBeliefs }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('belief-former: OPENAI_API_KEY not set');

	const userMessage = formatPrompt({ observation, similarObservations, candidateBeliefs });

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`
		},
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
	if (!res.ok) {
		throw new Error(`belief-former LLM: ${res.status} ${await res.text()}`);
	}
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

function formatPrompt({ observation, similarObservations, candidateBeliefs }) {
	const obsBlock = [
		`# new observation`,
		`id: ${observation.id}`,
		`summary: ${observation.summary}`,
		`salience: ${observation.salience}`,
		`entities: ${JSON.stringify(observation.entities ?? {})}`,
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
				.map(
					(b) =>
						`- [${b.id}] (sim=${(b.similarity ?? 0).toFixed(2)}, conf=${b.confidence.toFixed(2)}, ${
							b.explicitness
						}, by=${b.created_by}) "${b.claim}"\n    scope: ${JSON.stringify(b.scope ?? {})}`
				)
				.join('\n')
		: '(no existing beliefs in this workspace match)';

	return `${obsBlock}

# similar past observations (for context only — do not create beliefs about them)
${obsContext}

# candidate beliefs (the only ids you may use for action=attach)
${beliefContext}

Emit a JSON object with field "ops" matching the schema.`;
}

// ── op application ───────────────────────────────────────────────────────────

async function applyOp({ workspace_id, observation, op, candidateBeliefs }) {
	if (op.action === 'noop') return { action: 'noop', reason: op.reason };

	if (op.action === 'attach') {
		if (!op.belief_id || typeof op.weight !== 'number') {
			throw new Error(`attach op missing belief_id/weight: ${JSON.stringify(op)}`);
		}
		const belief = candidateBeliefs.find((b) => b.id === op.belief_id);
		if (!belief) throw new Error(`attach op references unknown belief_id ${op.belief_id}`);

		await memory.attachEvidence(belief.id, observation.id, op.weight);
		const next = applyConfidenceDelta(belief.confidence, op.weight, observation.salience);
		await memory.updateBelief(belief.id, { confidence: next });
		return {
			action: 'attach',
			belief_id: belief.id,
			weight: op.weight,
			confidence_before: belief.confidence,
			confidence_after: next,
			reason: op.reason
		};
	}

	if (op.action === 'create') {
		if (!op.claim || !op.explicitness) {
			throw new Error(`create op missing claim/explicitness: ${JSON.stringify(op)}`);
		}
		// Initial confidence for an agent-created belief: scale by salience.
		// A stated 0.9-salience signal yields a 0.7 belief; we let evidence
		// build from there.
		const initial = clamp01(observation.salience * (op.explicitness === 'stated' ? 0.8 : 0.5));
		const belief = await memory.createBelief(workspace_id, {
			claim: op.claim,
			scope: op.scope ?? {},
			confidence: initial,
			explicitness: op.explicitness,
			created_by: 'agent',
			tags: op.tags ?? []
		});
		await memory.attachEvidence(belief.id, observation.id, 1.0);
		return {
			action: 'create',
			belief_id: belief.id,
			claim: op.claim,
			confidence: initial,
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

// ── helpers ──────────────────────────────────────────────────────────────────

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
