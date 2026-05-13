// list_vendors — return vendors this handle has mentioned, optionally filtered
// by property and/or trade. Derived from profile slugs `vendor/<trade>/<property>`.

import * as memory from '../memory.mjs';

export const listVendors = {
	name: 'list_vendors',
	description:
		'List vendors this user has mentioned. Optionally filter by trade or property slug.',
	parameters: {
		type: 'object',
		properties: {
			property: { type: 'string', description: 'Property slug to filter by.' },
			trade: {
				type: 'string',
				description: 'Trade to filter by (plumbing, electrical, hvac, etc).'
			}
		}
	},
	async run(args, ctx) {
		if (!ctx.handle) throw new Error('list_vendors: ctx.handle required');
		return { vendors: await memory.listVendors(ctx.handle, args || {}) };
	}
};
