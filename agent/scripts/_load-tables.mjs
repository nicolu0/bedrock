// Load Green Oak's crawled properties/units/tenants/owners into Supabase, idempotently,
// in FK order. Modeled on scripts/load-vendors.mjs (env parsing + PostgREST upsert
// with Prefer: resolution=merge-duplicates,return=representation).
//
//   node scripts/_load-tables.mjs
//
// Inputs (crawl phase):
//   appfolio/crawl/greenoak-properties.json
//   appfolio/crawl/greenoak-units.json
//   appfolio/crawl/greenoak-tenants.json
//   appfolio/crawl/greenoak-owners.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRAWL_DIR = path.resolve(HERE, '../appfolio/crawl');
const ENV_PATH = path.resolve(HERE, '../../.env');
const WORKSPACE_ID = '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7'; // Green Oak

// --- env (same parser as load-vendors.mjs) ---
const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (!m) continue;
	let v = m[2].trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
		v = v.slice(1, -1);
	env[m[1]] = v;
}
const SUPA = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !KEY) throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');

const issues = [];
const read = (f) => JSON.parse(fs.readFileSync(path.join(CRAWL_DIR, f), 'utf8'));
const norm = (s) => (s == null || s === '' ? null : String(s));

// Upsert helper: POST rows to /rest/v1/<table>?on_conflict=<cols>, return rows back.
async function upsert(table, onConflict, rows) {
	if (!rows.length) return [];
	const res = await fetch(`${SUPA}/rest/v1/${table}?on_conflict=${onConflict}`, {
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
		throw new Error(`upsert ${table} failed ${res.status}: ${(await res.text()).slice(0, 600)}`);
	}
	return res.json();
}

// Fetch back all rows for the workspace to build id maps (GET with select).
async function fetchAll(table, select, extraQuery = '') {
	const out = [];
	const pageSize = 1000;
	let from = 0;
	for (;;) {
		const res = await fetch(
			`${SUPA}/rest/v1/${table}?select=${select}&workspace_id=eq.${WORKSPACE_ID}${extraQuery}`,
			{
				headers: {
					apikey: KEY,
					Authorization: `Bearer ${KEY}`,
					Range: `${from}-${from + pageSize - 1}`,
					Prefer: 'count=exact'
				}
			}
		);
		if (!res.ok) throw new Error(`fetch ${table} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
		const batch = await res.json();
		out.push(...batch);
		if (batch.length < pageSize) break;
		from += pageSize;
	}
	return out;
}

// ---------------------------------------------------------------------------
// 1. PROPERTIES
//    Crawl JSON has street/zip; live schema uses address/postal_code.
// ---------------------------------------------------------------------------
const propsIn = read('greenoak-properties.json');
const propRows = propsIn.map((p) => ({
	workspace_id: WORKSPACE_ID,
	name: norm(p.name),
	address: norm(p.street),
	city: norm(p.city),
	state: norm(p.state),
	postal_code: norm(p.zip),
	appfolio_property_id: norm(p.appfolio_property_id),
	appfolio_property_number: norm(p.appfolio_property_number)
}));
await upsert('properties', 'workspace_id,appfolio_property_id', propRows);

// Map appfolio_property_id -> bedrock properties.id
const propsBack = await fetchAll('properties', 'id,appfolio_property_id');
const propMap = new Map(); // appfolio_property_id -> uuid
for (const r of propsBack) if (r.appfolio_property_id) propMap.set(String(r.appfolio_property_id), r.id);
const properties_loaded = propsBack.length;
console.log(`properties: upserted ${propRows.length}, ${properties_loaded} now in workspace`);

// ---------------------------------------------------------------------------
// 2. UNITS — resolve property_id via propMap; skip+report unresolved.
// ---------------------------------------------------------------------------
const unitsIn = read('greenoak-units.json');
const unitRows = [];
for (const u of unitsIn) {
	const pid = propMap.get(String(u.appfolio_property_id));
	if (!pid) {
		issues.push(
			`unit ${u.appfolio_unit_id} (${u.name}): property ${u.appfolio_property_id} not found — skipped`
		);
		continue;
	}
	unitRows.push({
		workspace_id: WORKSPACE_ID,
		name: norm(u.name),
		appfolio_unit_id: norm(u.appfolio_unit_id),
		property_id: pid
	});
}
await upsert('units', 'workspace_id,appfolio_unit_id', unitRows);

// Map appfolio_unit_id -> bedrock units.id
const unitsBack = await fetchAll('units', 'id,appfolio_unit_id');
const unitMap = new Map();
for (const r of unitsBack) if (r.appfolio_unit_id) unitMap.set(String(r.appfolio_unit_id), r.id);
const units_loaded = unitsBack.length;
console.log(`units: upserted ${unitRows.length}, ${units_loaded} now in workspace`);

// ---------------------------------------------------------------------------
// 3. TENANTS — resolve unit_id via unitMap; skip+report unresolved.
//    Dedup on (unit_id, email, name) to match the NULLS NOT DISTINCT index.
//    Do NOT set user_id (column dropped).
// ---------------------------------------------------------------------------
const tenantsIn = read('greenoak-tenants.json');
const seen = new Set();
const tenantRows = [];
for (const t of tenantsIn) {
	const uid = unitMap.get(String(t.appfolio_unit_id));
	if (!uid) {
		issues.push(`tenant ${t.name}: unit ${t.appfolio_unit_id} not found — skipped`);
		continue;
	}
	const email = norm(t.email);
	const name = norm(t.name);
	const key = `${uid}|${email ?? ''}|${name ?? ''}`;
	if (seen.has(key)) {
		issues.push(`tenant ${t.name} (unit ${t.appfolio_unit_id}): duplicate (unit,email,name) — deduped`);
		continue;
	}
	seen.add(key);
	tenantRows.push({
		unit_id: uid,
		name,
		email,
		phone: norm(t.phone)
	});
}
await upsert('tenants', 'unit_id,email,name', tenantRows);

// tenants has no workspace_id column — scope by the resolved unit ids instead.
const tenantUnitIds = [...new Set(tenantRows.map((r) => r.unit_id))];
let tenants_loaded = 0;
{
	const idList = tenantUnitIds.map((id) => `"${id}"`).join(',');
	const res = await fetch(
		`${SUPA}/rest/v1/tenants?select=id&unit_id=in.(${idList})`,
		{ headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
	);
	if (!res.ok) throw new Error(`fetch tenants failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
	tenants_loaded = (await res.json()).length;
}
console.log(`tenants: upserted ${tenantRows.length}, ${tenants_loaded} now in workspace`);

// ---------------------------------------------------------------------------
// 4. OWNERS + OWNER_PROPERTIES — resolve property_id via propMap.
// ---------------------------------------------------------------------------
const ownersFile = path.join(CRAWL_DIR, 'greenoak-owners.json');
let owners_loaded = 0;
let owner_properties_loaded = 0;
if (fs.existsSync(ownersFile)) {
	const ownersIn = read('greenoak-owners.json');
	const ownerRows = [];
	for (const o of ownersIn) {
		if (!o.appfolio_owner_id) {
			issues.push(`owner ${o.name ?? '(unnamed)'}: missing appfolio_owner_id — skipped`);
			continue;
		}
		ownerRows.push({
			workspace_id: WORKSPACE_ID,
			appfolio_owner_id: norm(o.appfolio_owner_id),
			name: norm(o.name) ?? norm(o.appfolio_owner_id),
			email: norm(o.email),
			phone: norm(o.phone),
			updated_at: new Date().toISOString()
		});
	}
	await upsert('owners', 'workspace_id,appfolio_owner_id', ownerRows);

	const ownersBack = await fetchAll('owners', 'id,appfolio_owner_id');
	const ownerMap = new Map();
	for (const r of ownersBack) if (r.appfolio_owner_id) ownerMap.set(String(r.appfolio_owner_id), r.id);
	owners_loaded = ownersBack.length;
	console.log(`owners: upserted ${ownerRows.length}, ${owners_loaded} now in workspace`);

	const seenOwnerProps = new Set();
	const ownerPropRows = [];
	for (const o of ownersIn) {
		const oid = ownerMap.get(String(o.appfolio_owner_id));
		if (!oid) continue;
		for (const appfolioPropId of o.appfolio_property_ids ?? []) {
			const pid = propMap.get(String(appfolioPropId));
			if (!pid) {
				issues.push(`owner ${o.name}: property ${appfolioPropId} not found — owner_properties skipped`);
				continue;
			}
			const key = `${oid}|${pid}`;
			if (seenOwnerProps.has(key)) continue;
			seenOwnerProps.add(key);
			ownerPropRows.push({
				workspace_id: WORKSPACE_ID,
				owner_id: oid,
				property_id: pid
			});
		}
	}
	await upsert('owner_properties', 'owner_id,property_id', ownerPropRows);

	const opBack = await fetchAll('owner_properties', 'id');
	owner_properties_loaded = opBack.length;
	console.log(
		`owner_properties: upserted ${ownerPropRows.length}, ${owner_properties_loaded} now in workspace`
	);
} else {
	issues.push('greenoak-owners.json missing — skipped owners load');
}

const result = {
	properties_loaded,
	units_loaded,
	tenants_loaded,
	owners_loaded,
	owner_properties_loaded,
	ok: issues.filter((i) => i.includes('not found')).length === 0,
	issues
};
console.log('\nRESULT ' + JSON.stringify(result));
