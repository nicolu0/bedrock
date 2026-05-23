// read_profile — read a slug, list a namespace prefix, or dump everything.
// Forgiving on miss: returns { found: false, similar: [...] } with the closest
// existing slug names so the model can retry without guessing.

import * as memory from '../memory.mjs';

function similar(slug, candidates, limit = 5) {
	const lc = String(slug).toLowerCase();
	const parts = lc.split('/').filter(Boolean);
	const scored = candidates.map((c) => {
		const lcc = c.toLowerCase();
		let score = 0;
		// shared prefix length
		let common = 0;
		for (let i = 0; i < Math.min(lc.length, lcc.length); i++) {
			if (lc[i] === lcc[i]) common++;
			else break;
		}
		score += common;
		// shared path segments
		const cp = lcc.split('/').filter(Boolean);
		for (const p of parts) if (cp.includes(p)) score += 5;
		// substring containment
		if (lcc.includes(lc) || lc.includes(lcc)) score += 3;
		return { c, score };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored.filter((x) => x.score > 0).slice(0, limit).map((x) => x.c);
}

export const readProfile = {
	name: 'read_profile',
	description:
		'Read a profile slug or list a namespace. Slugs are slash-paths (user/name, pref/tone, demo/stage, property/<slug>). Pass an exact slug to get its value; a prefix ending in "/" to list everything under it (e.g. "pref/" returns all pref/* slugs); empty or no arg to dump every slug. If an exact slug misses, returns { found: false, similar: [...] } with the closest existing slugs.',
	parameters: {
		type: 'object',
		properties: {
			slug: {
				type: 'string',
				description:
					'Exact slug for a single value, a prefix ending "/" to list a namespace, or empty/no arg for all slugs.'
			}
		}
	},
	async run({ slug }, ctx) {
		if (!ctx.handle) throw new Error('read_profile: ctx.handle required');
		const profile = await memory.getProfile(ctx.handle);
		const allSlugs = Object.keys(profile);

		if (!slug) {
			return { slugs: allSlugs, profile };
		}
		if (slug.endsWith('/')) {
			const out = {};
			for (const k of allSlugs) {
				if (k.startsWith(slug)) out[k] = profile[k];
			}
			return { prefix: slug, slugs: out };
		}
		if (Object.prototype.hasOwnProperty.call(profile, slug)) {
			return { slug, value: profile[slug] };
		}
		return { slug, found: false, similar: similar(slug, allSlugs) };
	}
};
