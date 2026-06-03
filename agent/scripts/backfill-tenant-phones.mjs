// Backfill missing tenant phone numbers from AppFolio's tenant directory
// (the "manual" Playwright crawl of the internal JSON:API — NOT the Reports
// API). Targets only tenants whose `phone` is null/empty, across both AppFolio
// workspaces. Tenant rows carry no appfolio_tenant_id, so we match a directory
// tenant by (unit's appfolio_unit_id + normalized name). PATCHes phone
// (digits-only) and fills appfolio_tenant_id when we match.
//
//   node scripts/backfill-tenant-phones.mjs            # both workspaces
//   node scripts/backfill-tenant-phones.mjs --dry-run  # show matches, no writes
//
// Needs a fresh appfolio/.state.<slug>.json session per vhost.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPFOLIO_DIR = path.resolve(HERE, '../appfolio');
const ENV_PATH = path.resolve(HERE, '../../.env');
const DRY = process.argv.includes('--dry-run');

const WORKSPACES = [
	{ vhost: 'lapm.appfolio.com', workspace_id: '2e4373a0-40b8-42c2-a873-b08c99dbf76a' },
	{
		vhost: 'greenoakpropertymanagement.appfolio.com',
		workspace_id: '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7'
	}
];

// --- env ---
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
const SUPA_H = { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' };

const normName = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '').trim();
const digits = (s) => (s || '').replace(/\D/g, '') || null;

async function getJson(url) {
	const res = await fetch(url, { headers: SUPA_H });
	if (!res.ok) throw new Error(`${res.status} on ${url}: ${(await res.text()).slice(0, 200)}`);
	return res.json();
}

// unit uuid -> appfolio_unit_id, for one workspace.
async function fetchUnitMap(workspace_id) {
	const params = new URLSearchParams({
		select: 'id,appfolio_unit_id',
		workspace_id: `eq.${workspace_id}`
	});
	const rows = await getJson(`${SUPA}/rest/v1/units?${params}`);
	return new Map(rows.map((u) => [u.id, u.appfolio_unit_id]));
}

// Tenants missing a phone whose unit is in this workspace.
async function fetchMissingTenants(unitMap) {
	const params = new URLSearchParams({
		select: 'id,name,phone,unit_id',
		or: '(phone.is.null,phone.eq.)'
	});
	const rows = await getJson(`${SUPA}/rest/v1/tenants?${params}`);
	return rows
		.filter((t) => unitMap.has(t.unit_id))
		.map((t) => ({ ...t, appfolio_unit_id: unitMap.get(t.unit_id) }));
}

// Crawl the AppFolio tenant directory → [{ id, name, appfolio_unit_id, phone }].
async function crawlTenants(context, base) {
	const H = {
		Accept: 'application/vnd.api+json',
		'accept-version': 'v2',
		'x-api-client': '/people'
	};
	const Q =
		'include=primary_phone_number,unit' +
		'&fields[tenants]=name,first_name,last_name' +
		'&fields[phone_numbers]=formatted_number' +
		'&fields[units]=id';
	const relId = (row, name) => {
		const d = row.relationships?.[name]?.data;
		const one = Array.isArray(d) ? d[0] : d;
		return one?.id ?? null;
	};
	const out = [];
	let pg = 1,
		totalPages = 1;
	do {
		const url = `${base}/api/tenants?page[size]=200&page[number]=${pg}&${Q}`;
		const r = await context.request.get(url, { headers: H });
		if (!r.ok())
			throw new Error(`tenant API ${r.status()} on page ${pg}: ${(await r.text()).slice(0, 200)}`);
		const j = await r.json();
		const idx = new Map();
		for (const it of j.included ?? []) idx.set(`${it.type}:${it.id}`, it.attributes ?? {});
		for (const t of j.data ?? []) {
			const a = t.attributes ?? {};
			const phoneId = relId(t, 'primary_phone_number');
			const phoneAttrs = phoneId ? idx.get(`phone_numbers:${phoneId}`) : null;
			out.push({
				id: String(t.id),
				name: a.name || [a.first_name, a.last_name].filter(Boolean).join(' '),
				appfolio_unit_id: relId(t, 'unit'),
				phone: digits(phoneAttrs?.formatted_number)
			});
		}
		totalPages = j.meta?.total_pages ?? 1;
		pg++;
	} while (pg <= totalPages);
	return out;
}

async function patchTenant(uuid, patch) {
	const res = await fetch(`${SUPA}/rest/v1/tenants?id=eq.${encodeURIComponent(uuid)}`, {
		method: 'PATCH',
		headers: { ...SUPA_H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
		body: JSON.stringify(patch)
	});
	if (!res.ok) throw new Error(`patch ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const browser = await chromium.launch({ headless: true });
let updated = 0;
const unresolved = [];
try {
	for (const { vhost, workspace_id } of WORKSPACES) {
		const slug = vhost.split('.')[0];
		const stateFile = path.join(APPFOLIO_DIR, `.state.${slug}.json`);
		if (!fs.existsSync(stateFile)) {
			console.log(`\n${vhost}: no session state (${path.basename(stateFile)}) — skipping`);
			continue;
		}
		const unitMap = await fetchUnitMap(workspace_id);
		const missing = await fetchMissingTenants(unitMap);
		console.log(`\n${vhost}: ${missing.length} tenant(s) without a phone`);
		if (!missing.length) continue;

		const context = await browser.newContext({ storageState: stateFile });
		let dir;
		try {
			dir = await crawlTenants(context, `https://${vhost}`);
		} finally {
			await context.close();
		}
		// key: appfolio_unit_id :: normalized name  (null = ambiguous collision)
		const byUnitName = new Map();
		for (const d of dir) {
			if (!d.appfolio_unit_id) continue;
			const k = `${d.appfolio_unit_id}::${normName(d.name)}`;
			byUnitName.set(k, byUnitName.has(k) ? null : d);
		}
		console.log(`  directory: ${dir.length} tenants fetched`);

		for (const row of missing) {
			const k = `${row.appfolio_unit_id}::${normName(row.name)}`;
			const match = byUnitName.get(k);
			if (!match) {
				const why = match === null ? 'unit+name AMBIGUOUS' : 'no directory match';
				console.log(`  ✗ ${row.name} — ${why}`);
				unresolved.push({ slug, name: row.name, why });
				continue;
			}
			if (!match.phone) {
				console.log(`  ✗ ${row.name} — directory has no phone`);
				unresolved.push({ slug, name: row.name, why: 'no phone in AppFolio' });
				continue;
			}
			console.log(`  ✓ ${row.name} → ${match.phone}${DRY ? ' [dry-run]' : ''}`);
			if (!DRY) {
				await patchTenant(row.id, { phone: match.phone, appfolio_tenant_id: match.id });
				updated++;
			}
		}
	}
} finally {
	await browser.close();
}

console.log(`\n${DRY ? '[dry-run] would update' : 'updated'} ${updated} tenant phone(s)`);
if (unresolved.length) {
	console.log(`${unresolved.length} unresolved:`);
	for (const u of unresolved) console.log(`  - [${u.slug}] ${u.name} (${u.why})`);
}
