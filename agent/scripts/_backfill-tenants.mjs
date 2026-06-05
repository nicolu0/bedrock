// Backfill current tenants for LAPM units that have ZERO tenants in our DB.
// Source of truth = AppFolio Reports API `rent_roll` (one row per unit, current
// occupant + TenantId + co-tenants). Contact info (phone/email) enriched from
// `tenant_directory` by tenant id when available. Matched by appfolio_unit_id ->
// units.id. Dry-run by default; pass --commit to write.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = process.argv.includes('--commit');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.resolve(HERE, '../../.env'), 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (m) env[m[1]] = m[2].trim();
}
const SB_URL = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const SB_H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' };
const LAPM = '2e4373a0-40b8-42c2-a873-b08c99dbf76a';
const VHOST = env.APPFOLIO_VHOST || 'lapm.appfolio.com';
const AF_AUTH = 'Basic ' + Buffer.from(`${env.APPFOLIO_CLIENT_ID}:${env.APPFOLIO_CLIENT_SECRET}`).toString('base64');
const OCCUPIED_STATUSES = new Set(['Current', 'Notice', 'Notice-Rented']);

async function sbGet(p) {
	const res = await fetch(`${SB_URL}/rest/v1/${p}`, { headers: SB_H });
	if (!res.ok) throw new Error(`SB GET ${p}: ${res.status} ${await res.text()}`);
	return res.json();
}
async function afReport(name) {
	let url = `https://${VHOST}/api/v1/reports/${name}.json?paginate_results=false`;
	const rows = [];
	while (url) {
		const res = await fetch(url, { headers: { Authorization: AF_AUTH, Accept: 'application/json' } });
		if (!res.ok) throw new Error(`AF ${name}: ${res.status}`);
		const j = await res.json();
		rows.push(...(Array.isArray(j) ? j : j.results ?? []));
		const next = Array.isArray(j) ? null : j.next_page_url;
		url = next ? (next.startsWith('http') ? next : `https://${VHOST}${next}`) : null;
	}
	return rows;
}
const cleanName = (s) => (s || '').replace(/\s+/g, ' ').trim();
function cleanPhone(s) {
	if (!s) return null;
	const d = String(s).split(',')[0].replace(/\D/g, '');
	const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
	return ten.length >= 10 ? ten.slice(-10) : d || null;
}
function cleanEmail(s) {
	if (!s) return null;
	const first = String(s).split(/[,;\s]+/).find((x) => x.includes('@'));
	return first ? first.trim().toLowerCase() : null;
}
// split parallel "a, b" / "id1,id2" lists into aligned pairs
function pairs(names, ids) {
	const n = (names ? String(names).split(',') : []).map((x) => x.trim()).filter(Boolean);
	const i = (ids != null ? String(ids).split(',') : []).map((x) => x.trim()).filter(Boolean);
	const out = [];
	const len = Math.max(n.length, i.length);
	for (let k = 0; k < len; k++) out.push({ name: n[k] ?? null, id: i[k] ?? null });
	return out;
}

// 1. DB state
const units = await sbGet(`units?workspace_id=eq.${LAPM}&select=id,appfolio_unit_id,name&limit=2000`);
const tenants = await sbGet(`tenants?select=unit_id&limit=5000`);
const occupied = new Set(tenants.map((t) => t.unit_id));
const targetByAf = new Map(units.filter((u) => u.appfolio_unit_id && !occupied.has(u.id)).map((u) => [String(u.appfolio_unit_id), u]));
console.log(`LAPM units: ${units.length} | tenant-less (target): ${targetByAf.size}`);

// 2. AppFolio sources
const rr = await afReport('rent_roll');
const dir = await afReport('tenant_directory');
const dirById = new Map();
for (const r of dir) if (r.SelectedTenantId != null) dirById.set(String(r.SelectedTenantId), r); // last wins; Current rows tend to sort last

// 3. Build rows from rent_roll
const seen = new Set();
const rows = [];
let vacantSkipped = 0;
const occupiedTargets = new Set();
for (const r of rr) {
	const u = targetByAf.get(String(r.UnitId));
	if (!u) continue;
	if (!OCCUPIED_STATUSES.has(r.Status)) {
		vacantSkipped++;
		continue;
	}
	const occupants = [{ name: r.Tenant, id: r.TenantId != null ? String(r.TenantId) : null }, ...pairs(r.AdditionalTenants, r.AdditionalTenantIds)];
	for (const occ of occupants) {
		const d = occ.id ? dirById.get(occ.id) : null;
		const name = cleanName(occ.name) || cleanName(d ? [d.FirstName, d.LastName].join(' ') : '');
		if (!name || name.includes('***')) continue;
		const key = `${u.id}:${occ.id ?? name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		occupiedTargets.add(u.id);
		rows.push({
			unit_id: u.id,
			name,
			email: cleanEmail(d?.Emails),
			phone: cleanPhone(d?.PhoneNumbers),
			appfolio_tenant_id: occ.id
		});
	}
}

const withContact = rows.filter((r) => r.phone || r.email).length;
console.log(`\nWould insert ${rows.length} tenants across ${occupiedTargets.size} occupied units.`);
console.log(`  with phone/email: ${withContact} | name+link only: ${rows.length - withContact}`);
console.log(`  target units skipped as vacant (rent_roll): ${vacantSkipped}`);
console.log('\n--- sample (first 20) ---');
for (const r of rows.slice(0, 20)) {
	const unit = [...targetByAf.values()].find((u) => u.id === r.unit_id);
	console.log(`  ${String(unit?.appfolio_unit_id).padStart(4)} ${(unit?.name || '').padEnd(32)} ${r.name.padEnd(28)} ${r.phone || '—'} ${r.email || '—'}`);
}
const coen = rows.find((r) => /coen/i.test(r.name));
console.log('\nCoen row:', JSON.stringify(coen));

fs.writeFileSync(path.join(HERE, '../appfolio/crawl/lapm-tenant-backfill.json'), JSON.stringify(rows, null, 2));

if (!COMMIT) {
	console.log('\n[DRY RUN] nothing written. Re-run with --commit to insert.');
	process.exit(0);
}
console.log('\n[COMMIT] inserting…');
let inserted = 0;
for (let i = 0; i < rows.length; i += 200) {
	const chunk = rows.slice(i, i + 200);
	const res = await fetch(`${SB_URL}/rest/v1/tenants`, {
		method: 'POST',
		headers: { ...SB_H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
		body: JSON.stringify(chunk)
	});
	if (!res.ok) throw new Error(`insert chunk ${i}: ${res.status} ${await res.text()}`);
	inserted += chunk.length;
	console.log(`  inserted ${inserted}/${rows.length}`);
}
console.log(`\n✓ inserted ${inserted} tenants.`);
