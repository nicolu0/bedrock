// Green Oak tenants crawl — AppFolio internal JSON:API → JSON array for Supabase.
// Mirrors scripts/appfolio-crawl.mjs (saved Playwright storageState session +
// JSON:API pagination + sideloaded-relationship resolution).
//
//   node scripts/_crawl-tenants.mjs
//
// Output: appfolio/crawl/greenoak-tenants.json — array of
//   { name, email, phone (digits only), appfolio_unit_id }
// Only tenants with a resolvable unit relationship are kept.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPFOLIO_DIR = path.resolve(HERE, '../appfolio');
const OUT_DIR = path.join(APPFOLIO_DIR, 'crawl');
const STATE = path.join(APPFOLIO_DIR, '.state.greenoakpropertymanagement.json');
const BASE = 'https://greenoakpropertymanagement.appfolio.com';
const OUT = path.join(OUT_DIR, 'greenoak-tenants.json');

const API_HEADERS = {
	Accept: 'application/vnd.api+json',
	'accept-version': 'v2',
	'x-api-client': '/people'
};

const TENANT_QUERY =
	'include=primary_email,primary_phone_number,unit' +
	'&fields[tenants]=name,first_name,last_name' +
	'&fields[emails]=email_address' +
	'&fields[phone_numbers]=formatted_number' +
	'&fields[units]=id';

// Resolve a to-one relationship's sideloaded attributes from the included index.
function relAttrs(row, name, idx) {
	const d = row.relationships?.[name]?.data;
	const one = Array.isArray(d) ? d[0] : d;
	if (!one) return null;
	return idx.get(`${one.type}:${one.id}`) ?? {};
}

// Resolve a to-one relationship's *id* (units carries the FK on the rel data).
function relId(row, name) {
	const d = row.relationships?.[name]?.data;
	const one = Array.isArray(d) ? d[0] : d;
	return one?.id ?? null;
}

async function crawlTenants(request, pageSize) {
	const rows = [];
	let pageNum = 1;
	let totalPages = 1;
	let totalCount = null;
	do {
		const url = `${BASE}/api/tenants?page[size]=${pageSize}&page[number]=${pageNum}&${TENANT_QUERY}`;
		const res = await request.get(url, { headers: API_HEADERS });
		if (!res.ok()) {
			const body = await res.text().catch(() => '');
			throw new Error(`API ${res.status()} on page ${pageNum}: ${body.slice(0, 300)}`);
		}
		const json = await res.json();
		if (json.errors) throw new Error(`API errors: ${JSON.stringify(json.errors).slice(0, 300)}`);

		const idx = new Map();
		for (const it of json.included ?? []) idx.set(`${it.type}:${it.id}`, it.attributes ?? {});

		for (const t of json.data ?? []) {
			const a = t.attributes ?? {};
			const unitId = relId(t, 'unit');
			if (!unitId) continue; // skip past/non-current tenants with no unit

			const email = relAttrs(t, 'primary_email', idx)?.email_address ?? null;
			const formatted = relAttrs(t, 'primary_phone_number', idx)?.formatted_number ?? null;
			const phone = formatted ? formatted.replace(/\D/g, '') : null;

			rows.push({
				name: a.name ?? [a.first_name, a.last_name].filter(Boolean).join(' ') ?? '',
				email,
				phone,
				appfolio_unit_id: unitId
			});
		}

		const meta = json.meta ?? {};
		totalCount = meta.total_count ?? totalCount;
		totalPages = meta.total_pages ?? totalPages;
		console.log(
			`  page ${pageNum}/${totalPages}: +${json.data?.length ?? 0} kept=${rows.length} (endpoint total ${totalCount})`
		);
		pageNum++;
	} while (pageNum <= totalPages);

	return { rows, totalCount };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE });
try {
	console.log('Crawling tenants from greenoakpropertymanagement.appfolio.com…');
	const { rows, totalCount } = await crawlTenants(context.request, 200);

	fs.mkdirSync(OUT_DIR, { recursive: true });
	fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));

	const ok = rows.length === totalCount;
	console.log(`\n✓ kept ${rows.length} tenants with a unit (endpoint total_count ${totalCount})`);
	console.log(`  count===total_count: ${ok}`);
	console.log(`  file: ${OUT}`);
	console.log('--- sample row ---');
	console.log(JSON.stringify(rows[0], null, 2));

	// machine-readable line for the parent to scrape if needed
	console.log(
		`RESULT ${JSON.stringify({ count: rows.length, total_count: totalCount, ok })}`
	);
} catch (err) {
	console.error(`crawl failed: ${err.message}`);
	console.error('if the session expired, re-mint .state.greenoakpropertymanagement.json');
	process.exitCode = 1;
} finally {
	await browser.close();
}
