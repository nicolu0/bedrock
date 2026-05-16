// add_observation — record a PM signal worth remembering. Workspace-scoped,
// written to Supabase, fires the belief-former asynchronously so a
// consolidated belief is ready by the next turn / next dispatch.
//
// Tool-call shape mirrors the design doc:
//   summary       — one-liner the LLM writes; this is what gets embedded
//   entities      — JSON of pinned ids (property_id, vendor_id, trade, ...)
//   salience      — 0..1, set at write time; "always" = 0.9+, casual = 0.3
//   tags          — free-form for retrieval; the nightly cron merges near-dupes
//   raw_text      — optional source message text
//   source_message_id — optional ref to iMessage row / PMS event

import * as memory from '../core/memory.mjs';
import { runBeliefFormer } from '../core/belief-former.mjs';

export const addObservation = {
	name: 'add_observation',
	description:
		'Record a PM signal worth remembering — a stated preference, a correction, an observed routing pattern, or context that informs future decisions. The summary is what gets embedded and recalled; write it as a self-contained one-liner ("Jose prefers Kori for handyman at Harrison Properties"). Set salience to reflect how emphatic the PM was: 0.9+ for explicit/always statements, 0.5-0.7 for situational, 0.2-0.4 for casual asides. Pin known entities so scoped retrieval works. Tags are free-form.',
	parameters: {
		type: 'object',
		properties: {
			summary: {
				type: 'string',
				description: 'Self-contained one-liner. This is what gets embedded.'
			},
			salience: {
				type: 'number',
				description: '0..1. How emphatic was the PM? 0.9+ for "always" statements, 0.2-0.4 for casual.'
			},
			entities: {
				type: 'object',
				description:
					'Known ids/values from this signal. Any subset of: property_id, unit_id, vendor_id, tenant_id, trade, problem_subtype, portfolio. Free-form — pin what you know.',
				additionalProperties: true
			},
			tags: {
				type: 'array',
				items: { type: 'string' },
				description: 'Free-form tags for retrieval (e.g. ["vendor-preference", "correction"]).'
			},
			raw_text: {
				type: 'string',
				description: 'Original PM message text, if applicable.'
			},
			source_message_id: {
				type: 'string',
				description: 'iMessage row id or PMS event id, if available.'
			}
		},
		required: ['summary', 'salience']
	},
	async run({ summary, salience, entities = {}, tags = [], raw_text = null, source_message_id = null }, ctx) {
		// Under evals: short-circuit BEFORE checking ctx.workspace_id, since
		// existing scenarios don't set it. The eval suite asserts tool call
		// behavior, not memory side effects.
		if (process.env.BEDROCK_EVAL_MODE === '1') {
			return { ok: true, observation_id: 'eval-mock', summary, salience };
		}
		if (!ctx.workspace_id) throw new Error('add_observation: ctx.workspace_id required');
		const observation = await memory.addObservation(ctx.workspace_id, {
			summary,
			salience,
			entities,
			tags,
			raw_text,
			source_message_id
		});
		// Fire-and-forget belief consolidation. Errors get logged but don't
		// fail the tool — observations are still valuable even if consolidation
		// hiccups.
		runBeliefFormer(ctx.workspace_id, observation.id).catch((err) => {
			ctx.onEvent?.({ type: 'belief_former_error', error: err.message, observation_id: observation.id });
		});
		return { ok: true, observation_id: observation.id };
	}
};
