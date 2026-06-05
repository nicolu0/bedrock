// One-off diagnostic: crawl LAPM tenants from AppFolio JSON:API and report
// how many have a current unit vs how many are skipped (no unit). Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPFOLIO_DIR = path.resolve(HERE, '../appfolio');
const OUT_DIR = path.join(APPFOLIO_DIR, 'crawl');
const STATE = path.join(APPFOLIO_DIR, '.state.lapm.json');
const BASE = 'https://lapm.appfolio.com';
const OUT = path.join(OUT_DIR, 'lapm-tenants.json');

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

function relId(row, name) {
	const d = row.relationships?.[name]?.data;
	const one = Array.isArray(d) ? d[0] : d;
	return one?.id ?? null;
}
function relAttrs(row, name, idx) {
	const d = row.relationships?.[name]?.data;
	const one = Array.isArray(d) ? d[0] : d;
	if (!one) return null;
	return idx.get(`${one.type}:${one.id}`) ?? {};
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE });
try {
	const withUnit = [];
	let noUnit = 0;
	let pageNum = 1;
	let totalPages = 1;
	let totalCount = null;
	do {
		const url = `${BASE}/api/tenants?page[size]=200&page[number]=${pageNum}&${TENANT_QUERY}`;
		const res = await context.request.get(url, { headers: API_HEADERS });
		if (!res.ok()) {
			const body = await res.text().catch(() => '');
			throw new Error(`API ${res.status()} page ${pageNum}: ${body.slice(0, 300)}`);
		}
		const json = await res.json();
		if (json.errors) throw new Error(`API errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
		const idx = new Map();
		for (const it of json.included ?? []) idx.set(`${it.type}:${it.id}`, it.attributes ?? {});
		for (const t of json.data ?? []) {
			const a = t.attributes ?? {};
			const unitId = relId(t, 'unit');
			const name = a.name ?? [a.first_name, a.last_name].filter(Boolean).join(' ');
			if (!unitId) {
				noUnit++;
				continue;
			}
			withUnit.push({
				name,
				email: relAttrs(t, 'primary_email', idx)?.email_address ?? null,
				phone: (relAttrs(t, 'primary_phone_number', idx)?.formatted_number ?? '').replace(/\D/g, '') || null,
				appfolio_unit_id: unitId
			});
		}
		const meta = json.meta ?? {};
		totalCount = meta.total_count ?? totalCount;
		totalPages = meta.total_pages ?? totalPages;
		console.log(`  page ${pageNum}/${totalPages}: +${json.data?.length ?? 0} withUnit=${withUnit.length} noUnit=${noUnit} (endpoint total ${totalCount})`);
		pageNum++;
	} while (pageNum <= totalPages);

	fs.mkdirSync(OUT_DIR, { recursive: true });
	fs.writeFileSync(OUT, JSON.stringify(withUnit, null, 2));

	const distinctUnits = new Set(withUnit.map((r) => r.appfolio_unit_id)).size;
	console.log(`\n=== LAPM AppFolio tenants ===`);
	console.log(`endpoint total_count: ${totalCount}`);
	console.log(`with current unit:    ${withUnit.length}`);
	console.log(`skipped (no unit):    ${noUnit}`);
	console.log(`distinct units occupied (AppFolio): ${distinctUnits}`);
	const coen = withUnit.filter((r) => /coen/i.test(r.name));
	console.log(`Coen matches: ${JSON.stringify(coen)}`);
	console.log(`RESULT ${JSON.stringify({ total_count: totalCount, with_unit: withUnit.length, no_unit: noUnit, distinct_units: distinctUnits })}`);
} catch (err) {
	console.error(`crawl failed: ${err.message}`);
	process.exitCode = 1;
} finally {
	await browser.close();
}
