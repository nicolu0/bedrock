// Enrich the used-vendor list with AppFolio's authoritative "Vendor Trade".
// The trade is NOT in the JSON:API (the `trades` relationship is a legacy
// multi-trade field AppFolio leaves empty) — it's rendered in the vendor
// detail page's server HTML as a datapair. So we map each used vendor name →
// its vendor id (via /api/vendors) → fetch /vendors/:id and parse the datapairs.
//
//   node scripts/enrich-vendors.mjs   # uses the latest greenoak-wos-*.json
//
// Writes appfolio/crawl/greenoak-vendors-<date>.json: name, id, trade, type,
// tags, wo_count. Reusable for refreshes; output is gitignored.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPFOLIO_DIR = path.resolve(HERE, '../appfolio');
const CRAWL_DIR = path.join(APPFOLIO_DIR, 'crawl');
const VHOST = process.env.APPFOLIO_VHOST || 'greenoakpropertymanagement.appfolio.com';
const slug = VHOST.split('.')[0];
const base = `https://${VHOST}`;
const stateFile = path.join(APPFOLIO_DIR, `.state.${slug}.json`);
const INTERNAL = /green oak property management/i;
const CANCELED = /cancel/i;

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

function latestWo() {
	const files = fs.readdirSync(CRAWL_DIR).filter((f) => /^greenoak-wos-.*\.json$/.test(f)).sort();
	if (!files.length) throw new Error('no greenoak-wos-*.json — run the crawl first');
	return path.join(CRAWL_DIR, files[files.length - 1]);
}

// distinct used vendors (real dispatches), with WO counts
const wos = JSON.parse(fs.readFileSync(latestWo(), 'utf8'));
const counts = new Map();
for (const r of wos) {
	if (!r.vendor || INTERNAL.test(r.vendor) || CANCELED.test(r.status)) continue;
	counts.set(r.vendor, (counts.get(r.vendor) || 0) + 1);
}
console.log(`used vendors to enrich: ${counts.size}`);

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: stateFile });
const API_H = { Accept: 'application/vnd.api+json', 'accept-version': 'v2', 'x-api-client': '/vendors' };

// name -> id from the full vendor directory
const nameToId = new Map();
let pg = 1, totalPages = 1;
do {
	const r = await context.request.get(`${base}/api/vendors?filter[include_hidden]=false&fields[vendors]=name&page[size]=200&page[number]=${pg}`, { headers: API_H });
	const j = await r.json();
	for (const v of j?.data ?? []) nameToId.set(norm(v.attributes?.name), v.id);
	totalPages = j?.meta?.total_pages ?? 1;
	pg++;
} while (pg <= totalPages);
console.log(`vendor directory: ${nameToId.size} names`);

function parseDatapairs(html) {
	const pairs = {};
	const re = /datapair__key[^>]*>\s*([^<]+?)\s*<\/div>\s*<div[^>]*datapair__value[^>]*>\s*([\s\S]*?)\s*<\/div>/gi;
	let m;
	while ((m = re.exec(html))) {
		const key = m[1].trim();
		const val = m[2].replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
		if (!(key in pairs)) pairs[key] = val;
	}
	return pairs;
}

const out = [];
let matched = 0, withTrade = 0, missing = [];
for (const [name, wo_count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
	const id = nameToId.get(norm(name));
	if (!id) { missing.push(name); out.push({ name, id: null, trade: '', type: '', tags: '', wo_count }); continue; }
	matched++;
	const r = await context.request.get(`${base}/vendors/${id}`, { headers: { Accept: 'text/html' } });
	const html = await r.text();
	const dp = parseDatapairs(html);
	const trade = dp['Vendor Trade'] || '';
	if (trade) withTrade++;
	out.push({ name, id, trade, type: dp['Vendor Type'] || '', tags: dp['Tags'] || '', wo_count });
}

await browser.close();

fs.mkdirSync(CRAWL_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const outPath = path.join(CRAWL_DIR, `greenoak-vendors-${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`\n✓ matched ${matched}/${counts.size} to vendor ids · ${withTrade} have an AppFolio Vendor Trade`);
if (missing.length) console.log(`  unmatched names (${missing.length}): ${missing.slice(0, 10).join(' | ')}${missing.length > 10 ? ' …' : ''}`);
console.log(`  wrote ${outPath}`);
console.log('\n  trade coverage sample:');
for (const v of out.filter((v) => v.trade).slice(0, 15)) console.log(`    ${v.trade.padEnd(22)} ${v.name} (${v.wo_count} WOs)`);
console.log('\n  used-but-no-trade:');
for (const v of out.filter((v) => v.id && !v.trade).slice(0, 12)) console.log(`    ${v.name} (${v.wo_count} WOs)`);
