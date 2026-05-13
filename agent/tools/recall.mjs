// recall — search past observations for relevant context. v1 is keyword/substring
// match ranked by hit count. Replace with embeddings later.

import * as memory from '../memory.mjs';

export const recall = {
	name: 'recall',
	description:
		'Search past observations about the user for relevant context. Returns matching notes ranked by keyword overlap.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Keywords or phrase to look up.' }
		},
		required: ['query']
	},
	async run({ query }, ctx) {
		if (!ctx.handle) throw new Error('recall: ctx.handle required');
		const results = await memory.recall(ctx.handle, query);
		return { results };
	}
};
