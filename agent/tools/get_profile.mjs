// get_profile — read a canonical fact by slug. Returns the stored string or
// null. Use this before asking the user something you might already know.

import * as memory from '../memory.mjs';

export const getProfile = {
	name: 'get_profile',
	description:
		'Read a canonical fact by slug. Returns { value: string | null }. Use before asking the user something you might already know.',
	parameters: {
		type: 'object',
		properties: {
			slug: { type: 'string', description: 'Canonical slug path.' }
		},
		required: ['slug']
	},
	async run({ slug }, ctx) {
		if (!ctx.handle) throw new Error('get_profile: ctx.handle required');
		const value = await memory.getProfile(ctx.handle, slug);
		return { value };
	}
};
