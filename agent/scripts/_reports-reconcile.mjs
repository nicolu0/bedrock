// Authoritative counts from AppFolio Reports API (v1) + reconcile vs our DB.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.resolve(HERE, '../../.env'), 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (m) env[m[1]] = m[2].trim();
}
const VHOST = env.APPFOLIO_VHOST || 'lapm.appfolio.com';
const AUTH = 'Basic ' + Buffer.from(`${env.APPFOLIO_CLIENT_ID}:${env.APPFOLIO_CLIENT_SECRET}`).toString('base64');

async function report(name, params = '') {
	let url = `https://${VHOST}/api/v1/reports/${name}.json?${params}`;
	const rows = [];
	while (url) {
		const res = await fetch(url, { headers: { Authorization: AUTH, Accept: 'application/json' } });
		if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
		const j = await res.json();
		const batch = Array.isArray(j) ? j : (j.results ?? []);
		rows.push(...batch);
		const next = Array.isArray(j) ? null : j.next_page_url;
		url = next ? (next.startsWith('http') ? next : `https://${VHOST}${next}`) : null;
	}
	return rows;
}

const uniq = (arr) => new Set(arr.filter((x) => x !== null && x !== undefined && x !== '')).size;

const units = await report('unit_directory', 'paginate_results=false');
const rr = await report('rent_roll', 'paginate_results=false');

console.log('=== unit_directory ===');
console.log('rows:', units.length, '| columns:', Object.keys(units[0] ?? {}).join(', '));
// bucket by any "type"-ish column
const typeKey = Object.keys(units[0] ?? {}).find((k) => /type/i.test(k));
if (typeKey) {
	const byType = {};
	for (const u of units) byType[u[typeKey] ?? '(blank)'] = (byType[u[typeKey] ?? '(blank)'] || 0) + 1;
	console.log(`by ${typeKey}:`, JSON.stringify(byType));
}

console.log('\n=== rent_roll (current occupancy) ===');
console.log('rows:', rr.length, '| columns:', Object.keys(rr[0] ?? {}).join(', '));
const unitKey = Object.keys(rr[0] ?? {}).find((k) => /^unit/i.test(k) && /id|address|name/i.test(k)) || 'Unit';
const tenantKey = Object.keys(rr[0] ?? {}).find((k) => /tenant/i.test(k) && /name/i.test(k));
const statusKey = Object.keys(rr[0] ?? {}).find((k) => /status/i.test(k));
console.log('distinct units in rent_roll:', uniq(rr.map((r) => r.UnitId ?? r[unitKey])));
console.log('distinct properties:', uniq(rr.map((r) => r.PropertyId)));
if (statusKey) {
	const byStatus = {};
	for (const r of rr) byStatus[r[statusKey] ?? '(blank)'] = (byStatus[r[statusKey] ?? '(blank)'] || 0) + 1;
	console.log(`by ${statusKey}:`, JSON.stringify(byStatus));
}
console.log('sample rent_roll row:', JSON.stringify(rr[0]));

fs.writeFileSync(path.join(HERE, '../appfolio/crawl/lapm-rent-roll.json'), JSON.stringify(rr, null, 2));
fs.writeFileSync(path.join(HERE, '../appfolio/crawl/lapm-unit-directory.json'), JSON.stringify(units, null, 2));
console.log('\nsaved rent_roll + unit_directory to appfolio/crawl/');
