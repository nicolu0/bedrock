// Ground-truth probe: ask AppFolio LAPM how many units/properties/tenants it has.
// Read-only. Prints meta.total_count for each endpoint + a sample tenant->unit
// relationship so we can confirm the id actually points at a `units` row.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.resolve(HERE, '../appfolio/.state.lapm.json');
const BASE = 'https://lapm.appfolio.com';
const H = { Accept: 'application/vnd.api+json', 'accept-version': 'v2', 'x-api-client': '/people' };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: STATE });
async function count(endpoint, query = '') {
	const url = `${BASE}/api/${endpoint}?page[size]=1&page[number]=1${query}`;
	const res = await ctx.request.get(url, { headers: H });
	if (!res.ok()) return `HTTP ${res.status()}: ${(await res.text()).slice(0, 200)}`;
	const j = await res.json();
	return { total_count: j.meta?.total_count, total_pages: j.meta?.total_pages, sample_type: j.data?.[0]?.type };
}
try {
	console.log('units       ', JSON.stringify(await count('units')));
	console.log('properties  ', JSON.stringify(await count('properties')));
	console.log('tenants(all)', JSON.stringify(await count('tenants')));
	// Try common AppFolio status filters to see if "current only" shrinks it.
	console.log('tenants future filter probe:');
	for (const f of ['filter[status]=current', 'filter[current]=true', 'filter[occupancy_status]=current']) {
		const r = await count('tenants', `&${f}`);
		console.log('   ', f, '=>', JSON.stringify(r));
	}
	// Pull one tenant with its unit included; print what type/id the rel resolves to.
	const res = await ctx.request.get(
		`${BASE}/api/tenants?page[size]=1&include=unit&fields[tenants]=name&fields[units]=property_and_unit_name,name`,
		{ headers: H }
	);
	const j = await res.json();
	const t = j.data?.[0];
	console.log('sample tenant:', t?.attributes?.name, '| unit rel:', JSON.stringify(t?.relationships?.unit?.data));
	console.log('included units:', JSON.stringify((j.included ?? []).filter((x) => x.type === 'units').map((u) => ({ id: u.id, ...u.attributes }))));
} catch (e) {
	console.error('probe failed:', e.message);
	process.exitCode = 1;
} finally {
	await browser.close();
}
