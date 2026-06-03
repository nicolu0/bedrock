// Green Oak properties crawler — JSON:API, reuses the saved Playwright session.
// Models its session + pagination on scripts/appfolio-crawl.mjs.
//
// Writes appfolio/crawl/greenoak-properties.json as an ARRAY of rows shaped for
// the Supabase loader:
//   { appfolio_property_id, appfolio_property_number, name, street, city, state, zip }
//
// NOTE on appfolio_property_number: LAPM's AppFolio account populates a separate
// short property number (e.g. "294" = 15 Ozone Ave), exposed in WO subjects.
// Green Oak's account does NOT — verified by probing 30+ candidate attribute
// names on multiple records, by unit-name prefixes (street numbers / "Unit N",
// never a "294-A" style prefix), and by the fact that the LAPM ground-truth ids
// don't exist in Green Oak's id-space. So this field is null for every Green Oak
// row. The key is kept (null) to keep the loader schema stable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPFOLIO_DIR = path.resolve(HERE, '../appfolio');
const OUT_DIR = path.join(APPFOLIO_DIR, 'crawl');
const STATE_FILE = path.join(APPFOLIO_DIR, '.state.greenoakpropertymanagement.json');
const BASE_URL = 'https://greenoakpropertymanagement.appfolio.com';
const OUT_FILE = path.join(OUT_DIR, 'greenoak-properties.json');

const API_HEADERS = {
	Accept: 'application/vnd.api+json',
	'accept-version': 'v2',
	'x-api-client': '/people'
};

// fields REQUIRED or the API 400s. include=address sideloads the address row.
const QUERY =
	'fields[properties]=name,display_name,name_and_address' +
	'&fields[addresses]=address1,address2,city,state,postal_code' +
	'&include=address';

// resolve a single related record from the sideloaded `included` set
function rel(record, name, idx) {
	const d = record.relationships?.[name]?.data;
	if (!d) return null;
	const one = Array.isArray(d) ? d[0] : d;
	if (!one) return null;
	return idx.get(`${one.type}:${one.id}`) ?? null;
}

async function loadChromium() {
	try {
		const { chromium } = await import('playwright');
		return chromium;
	} catch {
		console.error('\nplaywright not installed:\n  npm i -D playwright && npx playwright install chromium\n');
		process.exit(1);
	}
}

async function crawl(request, pageSize) {
	const rows = [];
	let pageNum = 1;
	let totalPages = 1;
	let totalCount = null;
	do {
		const url =
			`${BASE_URL}/api/properties?page[size]=${pageSize}&page[number]=${pageNum}&${QUERY}`;
		const res = await request.get(url, { headers: API_HEADERS });
		if (!res.ok()) {
			const body = await res.text().catch(() => '');
			throw new Error(`API ${res.status()} on page ${pageNum}: ${body.slice(0, 300)}`);
		}
		const json = await res.json();
		if (json.errors) throw new Error(`API errors: ${JSON.stringify(json.errors).slice(0, 300)}`);

		const idx = new Map();
		for (const it of json.included ?? []) idx.set(`${it.type}:${it.id}`, it.attributes ?? {});

		for (const p of json.data ?? []) {
			const a = p.attributes ?? {};
			const addr = rel(p, 'address', idx) ?? {};
			const street = [addr.address1, addr.address2].filter(Boolean).join(' ').trim() || null;
			rows.push({
				appfolio_property_id: String(p.id),
				appfolio_property_number: null, // not exposed on Green Oak's account (see header note)
				name: a.display_name || a.name || a.name_and_address || null,
				street,
				city: addr.city ?? null,
				state: addr.state ?? null,
				zip: addr.postal_code ?? null
			});
		}

		const meta = json.meta ?? {};
		totalCount = meta.total_count ?? totalCount;
		totalPages = meta.total_pages ?? totalPages;
		console.log(
			`  page ${pageNum}/${totalPages}: +${json.data?.length ?? 0} (total ${rows.length}${totalCount ? '/' + totalCount : ''})`
		);
		pageNum++;
	} while (pageNum <= totalPages);

	return { rows, totalCount };
}

async function main() {
	if (!fs.existsSync(STATE_FILE)) {
		console.error(`missing session state: ${STATE_FILE}\nre-mint with appfolio-crawl.mjs --login`);
		process.exit(1);
	}
	const chromium = await loadChromium();
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ storageState: STATE_FILE });
	try {
		console.log('Crawling properties from greenoakpropertymanagement.appfolio.com…');
		const { rows, totalCount } = await crawl(context.request, 200);

		fs.mkdirSync(OUT_DIR, { recursive: true });
		fs.writeFileSync(OUT_FILE, JSON.stringify(rows, null, 2));

		const ok = rows.length === totalCount;
		console.log(`\n${ok ? '✓' : '✗'} ${rows.length} properties (meta.total_count ${totalCount})`);
		console.log(`  out: ${OUT_FILE}`);
		console.log('  sample row:');
		console.log(JSON.stringify(rows[0], null, 2));

		// machine-readable summary line for the wrapper
		console.log('RESULT ' + JSON.stringify({ count: rows.length, total_count: totalCount, ok, file: OUT_FILE }));
	} catch (err) {
		console.error(`crawl failed: ${err.message}`);
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main();
