// Green Oak owners crawl — AppFolio internal JSON:API → JSON array for Supabase.
// Mirrors the Greenoak properties/units/tenants crawlers: saved Playwright
// storageState session + JSON:API pagination + sideloaded relationships.
//
//   node scripts/_crawl-owners.mjs
//
// Output: appfolio/crawl/greenoak-owners.json — array of
//   { appfolio_owner_id, name, email, phone, appfolio_property_ids }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPFOLIO_DIR = path.resolve(HERE, '../appfolio');
const OUT_DIR = path.join(APPFOLIO_DIR, 'crawl');
const STATE = path.join(APPFOLIO_DIR, '.state.greenoakpropertymanagement.json');
const BASE = 'https://greenoakpropertymanagement.appfolio.com';
const OUT = path.join(OUT_DIR, 'greenoak-owners.json');
const PAGE_SIZE = 200;

const API_HEADERS = {
	Accept: 'application/vnd.api+json',
	'accept-version': 'v2',
	'x-api-client': '/properties'
};

const PROPERTIES_QUERY =
	'fields[properties]=name,display_name,name_and_address,owners' +
	'&fields[owners]=name' +
	'&include=owners';

const OWNER_QUERY =
	'fields[owners]=name,first_name,last_name,hidden,deleted_at,primary_email,primary_phone_number' +
	'&fields[emails]=email_address' +
	'&fields[phone_numbers]=formatted_number' +
	'&include=primary_email,primary_phone_number';

function relAttrs(row, name, idx) {
	const d = row.relationships?.[name]?.data;
	const one = Array.isArray(d) ? d[0] : d;
	if (!one) return null;
	return idx.get(`${one.type}:${one.id}`)?.attributes ?? {};
}

function relIds(row, name) {
	const d = row.relationships?.[name]?.data;
	if (!d) return [];
	const many = Array.isArray(d) ? d : [d];
	return many.map((x) => x?.id).filter(Boolean).map(String);
}

function normalizePhone(v) {
	const s = v == null ? '' : String(v).trim();
	return s ? s.replace(/\D/g, '') || null : null;
}

async function crawlPropertyOwners(request) {
	const owners = new Map();
	let pageNum = 1;
	let totalPages = 1;
	let totalCount = null;
	do {
		const url =
			`${BASE}/api/properties?page[size]=${PAGE_SIZE}&page[number]=${pageNum}` +
			`&${PROPERTIES_QUERY}`;
		const res = await request.get(url, { headers: API_HEADERS });
		if (!res.ok()) {
			const body = await res.text().catch(() => '');
			throw new Error(`API ${res.status()} on page ${pageNum}: ${body.slice(0, 300)}`);
		}
		const json = await res.json();
		if (json.errors) throw new Error(`API errors: ${JSON.stringify(json.errors).slice(0, 300)}`);

		const idx = new Map();
		for (const it of json.included ?? []) idx.set(`${it.type}:${it.id}`, it);

		for (const property of json.data ?? []) {
			const propertyId = String(property.id);
			for (const ownerId of relIds(property, 'owners')) {
				const owner = idx.get(`owners:${ownerId}`);
				const a = owner?.attributes ?? {};
				if (!owners.has(ownerId)) {
					owners.set(ownerId, {
						appfolio_owner_id: ownerId,
						name: a.name || ownerId,
						email: null,
						phone: null,
						appfolio_property_ids: []
					});
				}
				owners.get(ownerId).appfolio_property_ids.push(propertyId);
			}
		}

		const meta = json.meta ?? {};
		totalCount = meta.total_count ?? totalCount;
		totalPages = meta.total_pages ?? totalPages;
		console.log(
			`  properties page ${pageNum}/${totalPages}: +${json.data?.length ?? 0} owners=${owners.size} (properties total ${totalCount})`
		);
		pageNum++;
	} while (pageNum <= totalPages);

	return { owners, propertyTotal: totalCount };
}

async function enrichOwners(request, owners) {
	let pageNum = 1;
	let totalPages = 1;
	let totalCount = null;
	do {
		const url =
			`${BASE}/api/owners?page[size]=${PAGE_SIZE}&page[number]=${pageNum}` +
			`&${OWNER_QUERY}`;
		const res = await request.get(url, { headers: API_HEADERS });
		if (!res.ok()) {
			const body = await res.text().catch(() => '');
			throw new Error(`owners API ${res.status()} on page ${pageNum}: ${body.slice(0, 300)}`);
		}
		const json = await res.json();
		if (json.errors) throw new Error(`owners API errors: ${JSON.stringify(json.errors).slice(0, 300)}`);

		const idx = new Map();
		for (const it of json.included ?? []) idx.set(`${it.type}:${it.id}`, it);

		for (const owner of json.data ?? []) {
			const ownerId = String(owner.id);
			const row = owners.get(ownerId);
			if (!row) continue;
			const a = owner.attributes ?? {};
			const email = relAttrs(owner, 'primary_email', idx)?.email_address ?? null;
			const phone = normalizePhone(relAttrs(owner, 'primary_phone_number', idx)?.formatted_number);
			row.name = a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || row.name;
			row.email = email;
			row.phone = phone;
		}

		const meta = json.meta ?? {};
		totalCount = meta.total_count ?? totalCount;
		totalPages = meta.total_pages ?? totalPages;
		console.log(`  owners page ${pageNum}/${totalPages}: +${json.data?.length ?? 0} (owners total ${totalCount})`);
		pageNum++;
	} while (pageNum <= totalPages);

	return totalCount;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE });
try {
	console.log('Crawling owners from greenoakpropertymanagement.appfolio.com…');
	const { owners, propertyTotal } = await crawlPropertyOwners(context.request);
	const ownerTotal = await enrichOwners(context.request, owners);
	const rows = [...owners.values()].map((row) => ({
		...row,
		appfolio_property_ids: [...new Set(row.appfolio_property_ids)].sort((a, b) => Number(a) - Number(b))
	}));

	fs.mkdirSync(OUT_DIR, { recursive: true });
	fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));

	const linked = rows.filter((r) => r.appfolio_property_ids.length > 0).length;
	console.log(`\n✓ kept ${rows.length} owners from ${propertyTotal} properties (owners endpoint total_count ${ownerTotal})`);
	console.log(`  with property ids: ${linked}`);
	console.log(`  file: ${OUT}`);
	console.log('--- sample row ---');
	console.log(JSON.stringify(rows[0], null, 2));
	console.log(
		`RESULT ${JSON.stringify({ count: rows.length, property_total_count: propertyTotal, owner_total_count: ownerTotal, with_property_ids: linked })}`
	);
} catch (err) {
	console.error(`crawl failed: ${err.message}`);
	console.error('if the session expired, re-mint .state.greenoakpropertymanagement.json');
	process.exitCode = 1;
} finally {
	await browser.close();
}
