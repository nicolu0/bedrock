// add_observation — append a fuzzy note about the handle. Use for preferences,
// anecdotes, context that doesn't fit a profile slug. Append-only; never edit.

import * as memory from '../memory.mjs';

export const addObservation = {
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
		if (!ctx.handle) throw new Error('add_observation: ctx.handle required');
		await memory.addObservation(ctx.handle, content, tags || []);
		return { ok: true };
	}
};
