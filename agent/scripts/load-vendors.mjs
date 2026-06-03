// Populate the `vendors` table for Green Oak from the resolved roster
// (scripts/build-cheatsheet.mjs output) + contact info pulled from AppFolio's
// vendor directory API. Idempotent upsert on (workspace_id, appfolio_vendor_id).
//
//   node scripts/build-cheatsheet.mjs   # writes greenoak-vendors-resolved-*.json
//   node scripts/load-vendors.mjs       # then this

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPFOLIO_DIR = path.resolve(HERE, '../appfolio');
const CRAWL_DIR = path.join(APPFOLIO_DIR, 'crawl');
const ENV_PATH = path.resolve(HERE, '../../.env');
const VHOST = process.env.APPFOLIO_VHOST || 'greenoakpropertymanagement.appfolio.com';
const slug = VHOST.split('.')[0];
const base = `https://${VHOST}`;
const stateFile = path.join(APPFOLIO_DIR, `.state.${slug}.json`);
const WORKSPACE_ID = '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7'; // Green Oak

// --- env ---
const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (!m) continue;
	let v = m[2].trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
	env[m[1]] = v;
}
const SUPA = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !KEY) throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');

// --- resolved roster ---
const rf = fs.readdirSync(CRAWL_DIR).filter((f) => /^greenoak-vendors-resolved-.*\.json$/.test(f)).sort().pop();
if (!rf) throw new Error('no resolved roster — run build-cheatsheet.mjs first');
const roster = JSON.parse(fs.readFileSync(path.join(CRAWL_DIR, rf), 'utf8'));
const withId = roster.filter((v) => v.appfolio_vendor_id);
console.log(`roster: ${roster.length} vendors (${withId.length} with an AppFolio id)`);

// --- contact info from the AppFolio vendor directory ---
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: stateFile });
const H = { Accept: 'application/vnd.api+json', 'accept-version': 'v2', 'x-api-client': '/vendors' };

const contact = new Map(); // vendor id -> {email, phone, street, street2, city, state, zip}
let pg = 1, totalPages = 1;
do {
	const url =
		`${base}/api/vendors?filter[include_hidden]=false&page[size]=200&page[number]=${pg}` +
		'&fields[vendors]=name&fields[emails]=email_address&fields[phone_numbers]=formatted_number' +
		'&fields[addresses]=address1,address2,city,state,postal_code' +
		'&include=primary_email,primary_phone_number,primary_address';
	const r = await context.request.get(url, { headers: H });
	const j = await r.json();
	const idx = new Map();
	for (const it of j.included ?? []) idx.set(`${it.type}:${it.id}`, it.attributes ?? {});
	const rel = (v, name) => {
		const d = v.relationships?.[name]?.data;
		return d ? idx.get(`${d.type}:${d.id}`) : null;
	};
	for (const v of j.data ?? []) {
		const a = rel(v, 'primary_address');
		contact.set(v.id, {
			email: rel(v, 'primary_email')?.email_address || null,
			phone: (rel(v, 'primary_phone_number')?.formatted_number || '').replace(/\D/g, '') || null,
			street: a?.address1 || null,
			street2: a?.address2 || null,
			city: a?.city || null,
			state: a?.state || null,
			zip: a?.postal_code || null
		});
	}
	totalPages = j.meta?.total_pages ?? 1;
	pg++;
} while (pg <= totalPages);
await browser.close();
console.log(`contact info fetched for ${contact.size} directory vendors`);

// --- build rows + upsert ---
const rows = withId.map((v) => ({
	workspace_id: WORKSPACE_ID,
	appfolio_vendor_id: String(v.appfolio_vendor_id),
	name: v.name,
	trade: v.trade || null,
	preference_index: 0,
	...(contact.get(v.appfolio_vendor_id) || {})
}));

const res = await fetch(`${SUPA}/rest/v1/vendors?on_conflict=workspace_id,appfolio_vendor_id`, {
	method: 'POST',
	headers: {
		apikey: KEY,
		Authorization: `Bearer ${KEY}`,
		'Content-Type': 'application/json',
		Prefer: 'resolution=merge-duplicates,return=representation'
	},
	body: JSON.stringify(rows)
});
if (!res.ok) {
	console.error(`upsert failed ${res.status}: ${(await res.text()).slice(0, 400)}`);
	process.exit(1);
}
const back = await res.json();
console.log(`\n✓ upserted ${back.length} vendors into Green Oak's vendors table`);
const noContact = rows.filter((r) => !r.email && !r.phone).length;
const noTrade = rows.filter((r) => !r.trade).length;
console.log(`  ${rows.length - noContact} have email/phone · ${rows.length - noTrade} have a trade`);
if (roster.length - withId.length > 0) {
	console.log(`  skipped ${roster.length - withId.length} without an AppFolio id: ${roster.filter((v) => !v.appfolio_vendor_id).map((v) => v.name).join(', ')}`);
}
