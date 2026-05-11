// Tool definitions in OpenAI function-calling shape + their implementations.
// send_text pushes to the per-turn outbox; everything else hits memory.mjs.

import * as memory from './memory.mjs';

export const TOOL_DEFS = [
	{
		type: 'function',
		function: {
			name: 'send_text',
			description: 'Send one iMessage to the user. Call multiple times in a turn for multiple separate texts.',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'The text body.' },
				},
				required: ['content'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_profile',
			description: 'Save or overwrite a canonical fact about the user. Slugs are slash-paths like user/name, property/<slug>/units, vendor/<trade>/<property-slug>. Pass empty value to delete.',
			parameters: {
				type: 'object',
				properties: {
					slug: { type: 'string' },
					value: { type: 'string' },
				},
				required: ['slug', 'value'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_profile',
			description: 'Read a canonical fact by slug. Returns the stored value or null. Use before asking the user something you might already know.',
			parameters: {
				type: 'object',
				properties: {
					slug: { type: 'string' },
				},
				required: ['slug'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'add_observation',
			description: 'Log a fuzzy note about the user — a preference, trait, anecdote, or context that does not fit a profile slug.',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string' },
					tags: { type: 'array', items: { type: 'string' } },
				},
				required: ['content'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'recall',
			description: 'Search past observations for relevant context. Returns matching notes ranked by keyword overlap.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string' },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_properties',
			description: 'List all properties this user has mentioned managing.',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_vendors',
			description: 'List vendors this user has mentioned. Optionally filter by trade or property.',
			parameters: {
				type: 'object',
				properties: {
					property: { type: 'string', description: 'Property slug to filter by.' },
					trade: { type: 'string', description: 'Trade to filter by (plumbing, electrical, hvac, etc).' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'react_to_message',
			description: 'Add or remove a tapback (heart, thumbs up/down, ha-ha, !!, ?) on the user\'s most recent message. Use sparingly — only when a reaction would feel natural in real iMessage. Examples: love-react when they share something exciting; laugh-react when they make a joke; emphasize-react when they say something important you want to acknowledge without typing back. Avoid reacting to every message.',
			parameters: {
				type: 'object',
				properties: {
					reaction: {
						type: 'string',
						enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'],
						description: 'Tapback type. love=heart, like=thumbs up, dislike=thumbs down, laugh=ha-ha, emphasize=!!, question=?',
					},
				},
				required: ['reaction'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'set_demo_stage',
			description: 'Advance the demo state machine. Stages in order: intro (waiting for confirmation), setup (collecting property + vendor), dispatch (live work order, get approval, send vendor + tenant), learning (ask if this should be the default for similar issues), followup (monitoring + auto-followup pitch), complete (done). Call this when the current stage is finished.',
			parameters: {
				type: 'object',
				properties: {
					stage: { type: 'string', enum: ['setup', 'dispatch', 'learning', 'followup', 'complete'] },
				},
				required: ['stage'],
			},
		},
	},
];

export async function executeTool(name, args, ctx) {
	const { handle, outbox } = ctx;
	switch (name) {
		case 'send_text': {
			// Defensive split: even though the prompt forbids it, if the model
			// puts line breaks inside a single send_text we treat each segment
			// as its own message so the user-facing stream stays clean.
			const text = String(args?.content ?? '').trim();
			if (!text) return { ok: true };
			for (const part of text.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
				outbox.push(part);
			}
			return { ok: true };
		}
		case 'update_profile': {
			await memory.updateProfile(handle, args.slug, args.value);
			return { ok: true };
		}
		case 'get_profile': {
			const value = await memory.getProfile(handle, args.slug);
			return { value };
		}
		case 'add_observation': {
			await memory.addObservation(handle, args.content, args.tags || []);
			return { ok: true };
		}
		case 'recall': {
			const results = await memory.recall(handle, args.query);
			return { results };
		}
		case 'list_properties': {
			return { properties: await memory.listProperties(handle) };
		}
		case 'list_vendors': {
			return { vendors: await memory.listVendors(handle, args || {}) };
		}
		case 'react_to_message': {
			if (typeof ctx.react !== 'function') {
				return { ok: false, error: 'react capability not available in this context' };
			}
			const r = await ctx.react(args.reaction);
			return { ok: r?.ok !== false, error: r?.error };
		}
		case 'set_demo_stage': {
			await memory.updateProfile(handle, 'system/stage', args.stage);
			return { ok: true, stage: args.stage };
		}
		default:
			return { error: `unknown tool ${name}` };
	}
}
