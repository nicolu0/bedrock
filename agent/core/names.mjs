// Display-name + text-casing helpers shared by the draft tools and the reminder
// builder: vendor short names (shortenVendorName), tenant first name (firstName),
// and mid-sentence casing (lowerLead). All deterministic — no model call.
//
// shortenVendorName: turn a vendor's canonical/legal name into how the PM
// actually refers to them. Two transforms, in order:
//   1. strip corporate suffixes + trailing punctuation
//        "Cross Appliance Inc"  → "Cross Appliance"
//        "Osalpa Electric, INC." → "Osalpa Electric"
//   2. first name for individuals, IF that first name is unique in the
//      workspace roster
//        "Yonic Herrera"        → "Yonic"
//        two "Luis ..." vendors → keep full names so they stay distinguishable
//
// What it deliberately does NOT do: invent the habitual short trade name a PM
// uses ("Osalpa Electric" → "Osalpa"). That isn't mechanical — it comes from a
// per-vendor short_name override, which is deferred. Derive-only for now.

// Trailing tokens that mark a legal entity, dropped from the display name.
const SUFFIXES = new Set(['inc', 'llc', 'l.l.c.', 'corp', 'co', 'ltd', 'company', 'incorporated']);

// Words that mark a name as a BUSINESS, not a person — so we keep the whole
// (suffix-stripped) name rather than collapsing it to a first token.
const COMPANY_WORDS = new Set([
	'electric',
	'electrical',
	'plumbing',
	'plumber',
	'appliance',
	'appliances',
	'hvac',
	'heating',
	'cooling',
	'air',
	'conditioning',
	'roofing',
	'roof',
	'construction',
	'services',
	'service',
	'maintenance',
	'repair',
	'repairs',
	'disposal',
	'disposals',
	'cleaning',
	'painting',
	'paint',
	'landscaping',
	'pest',
	'control',
	'solutions',
	'brothers',
	'bros',
	'handyman',
	'pools',
	'pool',
	'glass',
	'garage',
	'door',
	'doors',
	'flooring',
	'remodeling',
	'restoration',
	'and',
	'&'
]);

// Drop trailing legal-suffix tokens. Tolerates comma-attached suffixes
// ("Electric, INC.") and trailing punctuation, then trims a dangling comma off
// the new last token.
function stripSuffixes(name) {
	let tokens = String(name).trim().split(/\s+/);
	while (tokens.length > 1) {
		const last = tokens[tokens.length - 1].replace(/[.,]+$/g, '').toLowerCase();
		if (SUFFIXES.has(last)) {
			tokens.pop();
			continue;
		}
		break;
	}
	return tokens
		.join(' ')
		.replace(/[\s,]+$/g, '')
		.trim();
}

// A "Firstname Lastname" personal name: exactly two alphabetic tokens, neither
// of which is a business word. "Yonic Herrera" → yes; "Cross Appliance" → no
// ("appliance" is a company word); "Osalpa Electric" → no.
function looksLikePerson(base) {
	const tokens = base.split(/\s+/);
	if (tokens.length !== 2) return false;
	return tokens.every((t) => /^[A-Za-z'’.-]+$/.test(t) && !COMPANY_WORDS.has(t.toLowerCase()));
}

function firstNameCollides(base, name, roster) {
	const first = base.split(/\s+/)[0].toLowerCase();
	const self = String(name).trim().toLowerCase();
	return (roster ?? [])
		.map((r) => (typeof r === 'string' ? r : r?.name))
		.filter(Boolean)
		.filter((n) => n.trim().toLowerCase() !== self)
		.some((n) => {
			const b = stripSuffixes(n);
			return looksLikePerson(b) && b.split(/\s+/)[0].toLowerCase() === first;
		});
}

// roster: optional array of the workspace's vendor names (strings or {name}).
// Used only to detect first-name collisions; omit it and a personal name always
// shortens to the first name.
export function shortenVendorName(name, roster = []) {
	if (!name) return name;
	const base = stripSuffixes(name);
	if (!looksLikePerson(base)) return base;
	return firstNameCollides(base, name, roster) ? base : base.split(/\s+/)[0];
}

// First name only, for a tenant greeting ("Hi Nikayla N. Belford," → "Hi Nikayla,").
// Drops middle names, initials, and surname. No collision guard (unlike vendor
// names): the tenant reads their own message, so a shared first name is fine.
// Tenant names are stored First-first ("Nikayla N. Belford"), so the first
// whitespace token is the given name. Falls back to the trimmed input if empty.
export function firstName(name) {
	if (!name) return name;
	const trimmed = String(name).trim();
	return trimmed.split(/\s+/)[0] || trimmed;
}

// Lowercase a leading capital so an interpolated phrase reads mid-sentence
// ("Dead outlets" → "dead outlets") — but leave acronyms and all-caps tokens
// alone ("AC not blowing cold" stays "AC ...", "GFCI tripped" stays "GFCI ...").
// Only a Title-cased word (capital followed by a lowercase letter) is flipped.
export function lowerLead(s) {
	if (!s) return s;
	return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}
