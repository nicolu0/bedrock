// recall_observations — vector lookup over raw PM signals. Prefer
// recall_beliefs (consolidated). Use this only when you need the raw
// underlying evidence ("when did Jose first mention Yonic?") rather than the
// summary belief.

import * as memory from '../core/memory.mjs';

export const recallObservations = {
	name: 'recall_observations',
	description:
		'Look up raw PM signals (observations) matching a query. Returns episodic events, not consolidated beliefs — prefer recall_beliefs unless you specifically need the raw history.',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Free-form text to vector-match against observation summaries.'
			},
			top_k: {
				type: 'integer',
				description: 'How many observations to return. Default 5.'
			}
		},
		required: []
	},
	async run({ query = null, top_k = 5 }, ctx) {
		if (process.env.BEDROCK_EVAL_MODE === '1') return { observations: [] };
		if (!ctx.workspace_id) throw new Error('recall_observations: ctx.workspace_id required');
		const results = await memory.recallObservations(ctx.workspace_id, { query, top_k });
		return { observations: results };
	}
};
