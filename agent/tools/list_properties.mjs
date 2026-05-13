// list_properties — return all properties this handle has mentioned managing.
// Derived from profile slugs of the form `property/<slug>`.

import * as memory from '../memory.mjs';

export const listProperties = {
	name: 'list_properties',
	description: 'List all properties this user has mentioned managing.',
	parameters: { type: 'object', properties: {} },
	async run(_args, ctx) {
		if (!ctx.handle) throw new Error('list_properties: ctx.handle required');
		return { properties: await memory.listProperties(ctx.handle) };
	}
};
