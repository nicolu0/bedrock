// @ts-nocheck
const TRADE_ALIASES = {
	plumb: ['plumbing', 'plumber', 'plumbers'],
	electr: ['electrician', 'electrical', 'electricians', 'electric'],
	handyman: ['handyman', 'handymen', 'general', 'general contractor'],
	hvac: ['hvac', 'heating', 'cooling', 'air conditioning', 'air-conditioning'],
	paint: ['painter', 'painting', 'painters'],
	carpet: ['carpet', 'flooring', 'floor'],
	roof: ['roofing', 'roofer', 'roofers'],
	landscap: ['landscaping', 'landscaper', 'landscapers', 'lawn', 'grounds'],
	clean: ['cleaning', 'cleaner', 'cleaners', 'janitorial'],
	pest: ['pest control', 'exterminator', 'exterminators'],
	drywall: ['drywall', 'sheetrock', 'plastering'],
	tile: ['tile', 'tiling', 'tiler'],
	window: ['window', 'windows', 'glazing'],
	locksmith: ['locksmith', 'locksmithing', 'locks'],
	appliance: ['appliance', 'appliances', 'appliance repair']
};

/**
 * @param {Array<{name?: string|null, email?: string|null, trade?: string|null}>} vendors
 * @param {string} query
 */
export function searchVendors(vendors, query) {
	const q = query.trim().toLowerCase();
	if (!q) return vendors;

	// Find all trade aliases that match the query
	const matchedTrades = Object.entries(TRADE_ALIASES)
		.filter(([key, aliases]) => key.includes(q) || aliases.some((a) => a.includes(q)))
		.flatMap(([, aliases]) => aliases);

	return vendors.filter((v) => {
		const name = (v.name ?? '').toLowerCase();
		const email = (v.email ?? '').toLowerCase();
		const trade = (v.trade ?? '').toLowerCase();
		return (
			name.includes(q) ||
			email.includes(q) ||
			trade.includes(q) ||
			matchedTrades.some((t) => trade.includes(t))
		);
	});
}
