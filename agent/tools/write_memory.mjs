// write_memory — the agent's single write surface into the memory graph.
// One call resolves entities, appends an observation (with entity edges,
// session_id, source_message_id), runs the property→owner cascade, and fires
// the belief-former asynchronously.
//
// Why one tool: the chat-skill LLM doesn't need three knobs (observation +
// entity + belief). It needs to say "remember this." The tool owns the
// full write pipeline so batch and live paths share the same structural
// completeness.

import * as memory from '../core/memory.mjs';
import * as entities from '../core/entities.mjs';
import { runBeliefFormer } from '../core/belief-former.mjs';

const ENTITY_KINDS = new Set(['vendor', 'property', 'owner']);

export const writeMemory = {
	name: 'write_memory',
	description:
		"Record an observation in the memory graph — your generous log of the PM's decisions. One call resolves named entities (vendor/property/owner), writes the observation with entity edges, cascades owners for any property, and queues belief consolidation (a SEPARATE, deliberately selective step that decides what becomes a durable belief). Log from every decision the PM makes: a vendor dispatch (confirmed OR overridden), a stated preference, a per-property quirk, a correction, a process/approval rule, or the reason behind a choice. Default to writing — observations are cheap evidence; capturing the decision is your job, not judging whether it earns a belief. Salience reflects how STRONG the signal is (0.9+ explicit/'always', 0.6-0.8 situational/override/reason, 0.3-0.5 a routine confirmation), NOT whether to write — low salience means log it low, never skip. Be smart about noise: skip ONLY when it would redundantly reinforce a belief you can already see at near-certain confidence, or when there is no decision at all (a question back to you, chit-chat). The summary is what gets embedded; write a self-contained one-liner (\"Jose prefers Kori for handyman at Harrison Properties\"). Entities is an array of {kind, name, weight?} — kind in {vendor, property, owner}; weight defaults to +1 for chosen, use negative (-0.5 to -1) for rejected (e.g. \"send Luigi instead of Yonic\" → Yonic weight -0.5). Tags are free-form.",
	parameters: {
		type: 'object',
		additionalProperties: false,
		properties: {
			title: {
				type: 'string',
				description:
					'Short scannable headline, ≤10 words, shape "subject → outcome". Examples: "Hub Champaign plumbing → Yonic", "Darwin → retired", "Solomon Grauzinis Trust → approval required". No parentheticals.'
			},
			summary: {
				type: 'string',
				description: 'Self-contained one-liner. This is what gets embedded.'
			},
			salience: {
				type: 'number',
				description:
					'0..1. How emphatic was the PM? 0.9+ for "always" statements, 0.2-0.4 for casual.'
			},
			entities: {
				type: 'array',
				description:
					'Named entities this signal is about. Each item: {kind, name, weight?}. kind ∈ {vendor, property, owner}. weight defaults to +1 (chosen); use negative (e.g. -0.5) for rejected/overridden.',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['kind', 'name'],
					properties: {
						kind: { type: 'string', enum: ['vendor', 'property', 'owner'] },
						name: { type: 'string' },
						weight: { type: 'number' }
					}
				}
			},
			tags: {
				type: 'array',
				items: { type: 'string' },
				description: 'Free-form tags for retrieval (e.g. ["vendor-preference", "correction"]).'
			},
			raw_text: {
				type: 'string',
				description: 'Original PM message text, if applicable.'
			}
		},
		required: ['title', 'summary', 'salience']
	},
	async run(
		{ title, summary, salience, entities: entityRefs = [], tags = [], raw_text = null },
		ctx
	) {
		// Eval mode: short-circuit before touching workspace state or Supabase.
		// The eval suite asserts tool-call shape, not memory side effects.
		if (process.env.BEDROCK_EVAL_MODE === '1') {
			return { ok: true, observation_id: 'eval-mock', title, summary, salience };
		}
		if (!ctx.workspace_id) throw new Error('write_memory: ctx.workspace_id required');

		// Cascade owners from any property entities BEFORE writing the obs, so
		// the cascaded owners land in the same observation_entities batch. This
		// mirrors backfill-from-chat.mjs::phaseEntities.
		const refsForObs = await expandEntityRefsWithCascade(ctx.workspace_id, entityRefs);

		const observation = await memory.addObservation(ctx.workspace_id, {
			title,
			summary,
			salience,
			entities: refsForObs,
			tags,
			raw_text,
			source_message_id: ctx.source_message_id ?? null,
			session_id: ctx.session_id ?? null
		});

		// Fire-and-forget belief consolidation. Errors get logged but don't
		// fail the tool — observations are still valuable even if consolidation
		// hiccups.
		runBeliefFormer(ctx.workspace_id, observation.id).catch((err) => {
			ctx.onEvent?.({
				type: 'belief_former_error',
				error: err.message,
				observation_id: observation.id
			});
		});

		return { ok: true, observation_id: observation.id };
	}
};

// Cascade owners for any property entities so the owner travels with the obs.
// Asymmetric on purpose: properties cascade UP, owners do NOT cascade DOWN.
// Returns a deduped list of {kind, name, weight} refs ready for
// memory.addObservation.
async function expandEntityRefsWithCascade(workspace_id, entityRefs) {
	const input = Array.isArray(entityRefs) ? entityRefs : [];
	const out = [];
	const seen = new Set(); // `${kind}:${normName}` — entity-table-side dedupe is in resolveEntity
	const push = (ref) => {
		if (!ref || !ref.kind || !ref.name) return;
		if (!ENTITY_KINDS.has(ref.kind)) return;
		const key = `${ref.kind}:${String(ref.name).trim().toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(ref);
	};

	for (const ref of input) push(ref);

	// For each property, resolve and cascade. We do the resolve here purely to
	// get the property entity row so cascadeOwners can FK-lookup owners.
	// memory.addObservation will resolve again on its side — that's idempotent.
	for (const ref of input) {
		if (ref?.kind !== 'property' || !ref?.name) continue;
		try {
			const propEntity = await entities.resolveEntity({
				workspace_id,
				kind: 'property',
				name: ref.name
			});
			const owners = await entities.cascadeOwners(propEntity, workspace_id);
			for (const o of owners) {
				push({ kind: 'owner', name: o.name, weight: 1 });
			}
		} catch (err) {
			console.error(`write_memory: cascadeOwners failed for property ${ref.name}: ${err.message}`);
		}
	}

	return out;
}
