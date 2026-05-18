// Legacy demo-skill add_observation — handle-scoped, file-backed. Kept for
// the F1 demo flow which has no workspace context. The canonical
// add_observation (agent/tools/add_observation.mjs) is workspace-scoped and
// writes to Supabase. Do not use this in new code.

import * as memory from '../memory.mjs';

export const addObservationDemo = {
	name: 'add_observation',
	description:
		'Log a fuzzy note about the user — a preference, trait, anecdote, or context that does not fit a profile slug. Append-only.',
	parameters: {
		type: 'object',
		properties: {
			content: { type: 'string', description: 'The note text.' },
			tags: {
				type: 'array',
				items: { type: 'string' },
				description: 'Optional tags for retrieval (e.g. ["preference", "vendor"]).'
			}
		},
		required: ['content']
	},
	async run({ content, tags }, ctx) {
		if (!ctx.handle) throw new Error('add_observation_demo: ctx.handle required');
		await memory.addObservation(ctx.handle, content, tags || []);
		return { ok: true };
	}
};
