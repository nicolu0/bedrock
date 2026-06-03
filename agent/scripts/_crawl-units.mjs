// Crawls Green Oak's AppFolio units into a JSON array for a Supabase load.
// Modeled on appfolio-crawl.mjs: reuses the saved Playwright storageState,
// calls the internal JSON:API directly, paginates, and resolves the parent
// property via the sideloaded `included` set.
//
//   node scripts/_crawl-units.mjs
//
// Output: appfolio/crawl/greenoak-units.json — array of
//   { appfolio_unit_id, appfolio_property_id, name }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPFOLIO_DIR = path.resolve(HERE, '../appfolio');
const OUT_DIR = path.join(APPFOLIO_DIR, 'crawl');

const VHOST = 'greenoakpropertymanagement.appfolio.com';
const SLUG = VHOST.split('.')[0];
const BASE_URL = `https://${VHOST}`;
const STATE_FILE = path.join(APPFOLIO_DIR, `.state.${SLUG}.json`);
const OUT_FILE = path.join(OUT_DIR, 'greenoak-units.json');
const PAGE_SIZE = 200;

// AppFolio's internal JSON:API headers (per the cracked recipe).
const API_HEADERS = {
	Accept: 'application/vnd.api+json',
	'accept-version': 'v2',
	'x-api-client': '/people'
};

// units list query — `fields` is REQUIRED or it 400s. property[id] only.
const UNITS_QUERY =
	'fields[units]=name,property_and_unit_name' +
	'&fields[properties]=id' +
	'&include=property';

async function loadChromium() {
	try {
		const { chromium } = await import('playwright');
		return chromium;
	} catch {
		console.error('\nplaywright not installed:\n  npm i -D playwright && npx playwright install chromium\n');
		process.exit(1);
	}
}

// Resolve a single relationship's parent id (we want the FK id, not attributes).
function relId(rec, name) {
	const d = rec.relationships?.[name]?.data;
	if (!d) return null;
	const one = Array.isArray(d) ? d[0] : d;
	return one?.id ?? null;
}

async function crawlUnits(request) {
	const rows = [];
	let pageNum = 1;
	let totalPages = 1;
	let totalCount = null;
	do {
		const url =
			`${BASE_URL}/api/units?page[size]=${PAGE_SIZE}&page[number]=${pageNum}` +
			`&${UNITS_QUERY}`;
		const res = await request.get(url, { headers: API_HEADERS });
		if (!res.ok()) {
			const body = await res.text().catch(() => '');
			throw new Error(`API ${res.status()} on page ${pageNum}: ${body.slice(0, 300)}`);
		}
		const json = await res.json();
		if (json.errors) throw new Error(`API errors: ${JSON.stringify(json.errors).slice(0, 300)}`);

		for (const unit of json.data ?? []) {
			const a = unit.attributes ?? {};
			rows.push({
				appfolio_unit_id: String(unit.id),
				appfolio_property_id: relId(unit, 'property'),
				name: a.property_and_unit_name || a.name || ''
			});
		}

		const meta = json.meta ?? {};
		totalCount = meta.total_count ?? totalCount;
		totalPages = meta.total_pages ?? totalPages;
		console.log(
			`  page ${pageNum}/${totalPages}: +${json.data?.length ?? 0} ` +
				`(total ${rows.length}${totalCount != null ? '/' + totalCount : ''})`
		);
		pageNum++;
	} while (pageNum <= totalPages);

	return { rows, totalCount };
}

async function main() {
	if (!fs.existsSync(STATE_FILE)) {
		console.error(`session state missing: ${STATE_FILE}`);
		process.exit(1);
	}
	const chromium = await loadChromium();
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ storageState: STATE_FILE });
	try {
		console.log(`Crawling units from ${VHOST}…`);
		const { rows, totalCount } = await crawlUnits(context.request);

		fs.mkdirSync(OUT_DIR, { recursive: true });
		fs.writeFileSync(OUT_FILE, JSON.stringify(rows, null, 2));

		const ok = totalCount != null && rows.length === totalCount;
		console.log(`\n✓ ${rows.length} units written (meta.total_count=${totalCount}, ok=${ok})`);
		console.log(`  json: ${OUT_FILE}`);
		console.log(`  sample: ${JSON.stringify(rows[0])}`);

		// Emit a machine-readable summary line for the caller.
		console.log(
			`RESULT ${JSON.stringify({
				count: rows.length,
				total_count: totalCount,
				ok,
				sample: rows[0]
			})}`
		);
		if (!ok) process.exitCode = 2;
	} catch (err) {
		console.error(`crawl failed: ${err.message}`);
		console.error('if the session expired, re-mint it via appfolio-crawl.mjs --login');
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main();
