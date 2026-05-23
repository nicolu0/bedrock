// write_profile — set or overwrite a canonical fact about the current handle.
// Slugs are slash-paths: user/<key>, property/<slug>, vendor/<trade>/<property>,
// system/<key>, demo/<key>, pref/<key>. Lowercase, dash-separated for multi-word
// values. Empty value deletes the slug.

import * as memory from '../memory.mjs';

export const writeProfile = {
	name: 'write_profile',
	description:
		'Save or overwrite a canonical fact about the user. Slugs are slash-paths like user/name, pref/tone, property/<slug>, vendor/<trade>/<property-slug>, demo/stage. Pass an empty value to delete a slug.',
	parameters: {
		type: 'object',
		properties: {
			slug: { type: 'string', description: 'Canonical slug path.' },
			value: { type: 'string', description: 'Value to store. Empty string deletes the slug.' }
		},
		required: ['slug', 'value']
	},
	async run({ slug, value }, ctx) {
		if (!ctx.handle) throw new Error('write_profile: ctx.handle required');
		await memory.updateProfile(ctx.handle, slug, value);
		return { ok: true };
	}
};
