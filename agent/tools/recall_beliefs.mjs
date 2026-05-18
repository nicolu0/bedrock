// recall_beliefs — vector + scope lookup over consolidated beliefs. Used by
// the chat skill before responding to the PM, and by the upstream vendor edge
// function (PR #2) when picking a vendor.

import * as memory from '../core/memory.mjs';

export const recallBeliefs = {
	name: 'recall_beliefs',
	description:
		'Look up what we believe about how this PM wants the work handled. Returns beliefs ranked by vector similarity to the query (if given) and recency otherwise. Use this BEFORE drafting or routing — beliefs are how the agent learns vendor preferences, routing rules, and per-property quirks.',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description:
					'Free-form question or claim to search by, e.g. "who do we use for plumbing at 829 Ocean Park" or "handyman default". Embedded and matched semantically.'
			},
			top_k: {
				type: 'integer',
				description: 'How many beliefs to return. Default 5.'
			}
		},
		required: []
	},
	async run({ query = null, top_k = 5 }, ctx) {
		if (process.env.BEDROCK_EVAL_MODE === '1') return { beliefs: [] };
		if (!ctx.workspace_id) throw new Error('recall_beliefs: ctx.workspace_id required');
		const results = await memory.recallBeliefs(ctx.workspace_id, { query, top_k });
		return { beliefs: results };
	}
};
