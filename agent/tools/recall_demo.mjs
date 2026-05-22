// Demo-skill recall — handle-scoped, file-backed, keyword match. Used by the
// onboarding flow (skills/demo.mjs) when there's no workspace yet. The post-
// onboarding sibling is tools/recall.mjs — workspace-scoped, hybrid graph
// retrieval. Both tools are exported to the LLM under the same name `recall`;
// each skill binds whichever one fits its lifecycle stage.

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
