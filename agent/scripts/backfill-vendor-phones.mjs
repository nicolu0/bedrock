// Backfill missing vendor phone numbers from AppFolio's vendor directory
// (the "manual" Playwright crawl of the internal JSON:API — NOT the Reports
// API). Targets only vendors whose `phone` is null/empty, across both
// AppFolio workspaces. Matches a directory vendor by appfolio_vendor_id when
// the row has one, otherwise by normalized name. PATCHes phone (digits-only)
// and fills appfolio_vendor_id when we matched by name.
//
//   node scripts/backfill-vendor-phones.mjs            # both workspaces
//   node scripts/backfill-vendor-phones.mjs --dry-run  # show matches, no writes
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

// Vendors in a workspace that still have no phone.
async function fetchMissing(workspace_id) {
	const params = new URLSearchParams({
		select: 'id,name,appfolio_vendor_id,phone',
		workspace_id: `eq.${workspace_id}`,
		or: '(phone.is.null,phone.eq.)'
	});
	const res = await fetch(`${SUPA}/rest/v1/vendors?${params}`, { headers: SUPA_H });
	if (!res.ok) throw new Error(`fetchMissing ${res.status}: ${await res.text()}`);
	return res.json();
}

// Crawl the AppFolio vendor directory → [{ id, name, phone }].
async function crawlDirectory(context, base) {
	const H = {
		Accept: 'application/vnd.api+json',
		'accept-version': 'v2',
		'x-api-client': '/vendors'
	};
	const out = [];
	let pg = 1,
		totalPages = 1;
	do {
		const url =
			`${base}/api/vendors?filter[include_hidden]=false&page[size]=200&page[number]=${pg}` +
			'&fields[vendors]=name&fields[phone_numbers]=formatted_number' +
			'&include=primary_phone_number';
		const r = await context.request.get(url, { headers: H });
		if (!r.ok())
			throw new Error(
				`directory API ${r.status()} on page ${pg}: ${(await r.text()).slice(0, 200)}`
			);
		const j = await r.json();
		const idx = new Map();
		for (const it of j.included ?? []) idx.set(`${it.type}:${it.id}`, it.attributes ?? {});
		for (const v of j.data ?? []) {
			const d = v.relationships?.primary_phone_number?.data;
			const phoneAttrs = d ? idx.get(`${d.type}:${d.id}`) : null;
			out.push({
				id: String(v.id),
				name: v.attributes?.name || '',
				phone: digits(phoneAttrs?.formatted_number)
			});
		}
		totalPages = j.meta?.total_pages ?? 1;
		pg++;
	} while (pg <= totalPages);
	return out;
}

async function patchVendor(uuid, patch) {
	const res = await fetch(`${SUPA}/rest/v1/vendors?id=eq.${encodeURIComponent(uuid)}`, {
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
		const missing = await fetchMissing(workspace_id);
		console.log(`\n${vhost}: ${missing.length} vendor(s) without a phone`);
		if (!missing.length) continue;

		const context = await browser.newContext({ storageState: stateFile });
		const base = `https://${vhost}`;
		let dir;
		try {
			dir = await crawlDirectory(context, base);
		} finally {
			await context.close();
		}
		const byId = new Map(dir.map((d) => [d.id, d]));
		const byName = new Map();
		for (const d of dir) {
			const k = normName(d.name);
			byName.set(k, byName.has(k) ? null : d); // null = ambiguous (collision)
		}
		console.log(`  directory: ${dir.length} vendors fetched`);

		for (const row of missing) {
			let match = null;
			let via = '';
			if (row.appfolio_vendor_id && byId.has(String(row.appfolio_vendor_id))) {
				match = byId.get(String(row.appfolio_vendor_id));
				via = `id ${row.appfolio_vendor_id}`;
			} else {
				const m = byName.get(normName(row.name));
				if (m) {
					match = m;
					via = 'name';
				} else if (m === null) via = 'name (AMBIGUOUS — skipped)';
			}
			if (!match || !match.phone) {
				const why = !match ? via || 'no directory match' : 'directory has no phone';
				console.log(`  ✗ ${row.name} — ${why}`);
				unresolved.push({ vhost, name: row.name, why });
				continue;
			}
			const patch = { phone: match.phone };
			if (!row.appfolio_vendor_id) patch.appfolio_vendor_id = match.id;
			console.log(`  ✓ ${row.name} → ${match.phone} (via ${via})${DRY ? ' [dry-run]' : ''}`);
			if (!DRY) {
				await patchVendor(row.id, patch);
				updated++;
			}
		}
	}
} finally {
	await browser.close();
}

console.log(`\n${DRY ? '[dry-run] would update' : 'updated'} ${updated} vendor phone(s)`);
if (unresolved.length) {
	console.log(`${unresolved.length} unresolved:`);
	for (const u of unresolved) console.log(`  - [${u.vhost.split('.')[0]}] ${u.name} (${u.why})`);
}
