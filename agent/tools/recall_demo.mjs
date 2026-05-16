// Legacy demo-skill recall — handle-scoped, file-backed, keyword match.
// Kept for the F1 demo flow. The canonical recall paths are recall_beliefs
// and recall_observations (workspace-scoped, vector-backed) — use those in
// new code.

import * as memory from '../memory.mjs';

export const recallDemo = {
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
		if (!ctx.handle) throw new Error('recall_demo: ctx.handle required');
		const results = await memory.recall(ctx.handle, query);
		return { results };
	}
};
