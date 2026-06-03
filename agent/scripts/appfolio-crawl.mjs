// AppFolio crawler — reuses the worker.mjs session model (Playwright
// storageState), but pulls from AppFolio's internal JSON:API instead of
// scraping the DOM. The new AppFolio UI is a React app: the Work Orders list
// renders client-side from /api/work_orders, so there's no <table> to scrape —
// we call that same endpoint directly with the saved session.
//
// Built for the Green Oak cold-start (no Reporting API). Dropping the status
// filter returns ALL work orders (full history), not just the open ones the UI
// shows — that history is the dispatch pattern we seed the memory graph from.
//
//   1. mint the session once (headed, human logs in):
//        node scripts/appfolio-crawl.mjs --vhost greenoakpropertymanagement.appfolio.com --login
//   2. crawl (headless, reuses the saved session):
//        node scripts/appfolio-crawl.mjs --vhost greenoakpropertymanagement.appfolio.com --out greenoak-wos
//
// Per-vhost state file (.state.<slug>.json) so Green Oak's login never clobbers
// LAPM's appfolio/.state.json. State + crawl output are gitignored.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPFOLIO_DIR = path.resolve(HERE, '../appfolio');
const OUT_DIR = path.join(APPFOLIO_DIR, 'crawl');

// AppFolio's internal JSON:API needs these or it 404s / 400s.
const API_HEADERS = {
	Accept: 'application/vnd.api+json',
	'accept-version': 'v2',
	'x-api-client': '/maintenance/service_requests/work_orders'
};

// The work_orders list query — fields + include copied from the app's own
// request (all known-valid). `fields` is REQUIRED by the API. No
// filter[status_code] → all statuses (full history, ~1273 vs 190 open).
const WO_QUERY =
	'fields[work_orders]=id,created_at,scheduled_start,scheduled_end,display_number,instructions,remarks,status,updated_at' +
	'&fields[occupancies]=name' +
	'&fields[units]=property_and_unit_name,name' +
	'&fields[properties]=display_name,name_and_address,property_type' +
	'&fields[users]=name,email' +
	'&fields[vendors]=name' +
	'&fields[work_order_categories]=name' +
	'&fields[companies]=name' +
	'&fields[service_requests]=id,request_type' +
	'&include=occupancy,unit,work_order_category,vendor,vendor_company,service_request,property';

function parseFlags(argv) {
	const f = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) f[key] = true;
		else { f[key] = next; i++; }
	}
	return f;
}

async function loadChromium() {
	try {
		const { chromium } = await import('playwright');
		return chromium;
	} catch {
		console.error('\nplaywright not installed:\n  npm i -D playwright && npx playwright install chromium\n');
		process.exit(1);
	}
}

function waitForEnter(prompt) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function looksLoggedOut(page) {
	await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
	if (/login|sign[_-]?in|sessions/i.test(page.url())) return true;
	if (await page.locator('input[type="password"]').count().catch(() => 0)) return true;
	return false;
}

// Headed, human logs in once; save storageState for this vhost.
async function login(chromium, baseUrl, stateFile) {
	const browser = await chromium.launch({ headless: false });
	const context = await browser.newContext(
		fs.existsSync(stateFile) ? { storageState: stateFile } : {}
	);
	const page = await context.newPage();
	await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
	if (await looksLoggedOut(page)) {
		console.log(`\nBrowser opened at ${baseUrl}. Log in fully (incl. 2FA) — HUMAN task.\n`);
		await waitForEnter('Press Enter once the dashboard is loaded… ');
	}
	if (await looksLoggedOut(page)) {
		console.log('⚠️  still logged out — not saving.');
	} else {
		await context.storageState({ path: stateFile });
		console.log(`✓ session saved to ${path.relative(process.cwd(), stateFile)}`);
	}
	await browser.close();
}

function rel(wo, name, idx) {
	const d = wo.relationships?.[name]?.data;
	if (!d) return null;
	const one = Array.isArray(d) ? d[0] : d;
	if (!one) return null;
	return idx.get(`${one.type}:${one.id}`) ?? null;
}

// Pull every work order via the JSON:API, resolving relationships from the
// sideloaded `included` set. Returns flat rows.
async function crawlWorkOrders(request, baseUrl, pageSize) {
	const rows = [];
	let pageNum = 1;
	let totalPages = 1;
	let total = null;
	do {
		const url =
			`${baseUrl}/api/work_orders?page[size]=${pageSize}&page[number]=${pageNum}` +
			`&sort=-created_at&${WO_QUERY}`;
		const res = await request.get(url, { headers: API_HEADERS });
		if (!res.ok()) {
			const body = await res.text().catch(() => '');
			throw new Error(`API ${res.status()} on page ${pageNum}: ${body.slice(0, 300)}`);
		}
		const json = await res.json();
		if (json.errors) throw new Error(`API errors: ${JSON.stringify(json.errors).slice(0, 300)}`);

		const idx = new Map();
		for (const it of json.included ?? []) idx.set(`${it.type}:${it.id}`, it.attributes ?? {});

		for (const wo of json.data ?? []) {
			const a = wo.attributes ?? {};
			const property = rel(wo, 'property', idx);
			const unit = rel(wo, 'unit', idx);
			const occ = rel(wo, 'occupancy', idx);
			const cat = rel(wo, 'work_order_category', idx);
			const vendor = rel(wo, 'vendor', idx);
			const company = rel(wo, 'vendor_company', idx);
			rows.push({
				wo_number: a.display_number ?? '',
				created_at: a.created_at ?? '',
				status: a.status ?? '',
				property: property?.name_and_address || property?.display_name || '',
				unit: unit?.property_and_unit_name || unit?.name || '',
				tenant: occ?.name || '',
				category: cat?.name || '',
				vendor: vendor?.name || company?.name || '',
				description: (a.remarks || a.instructions || '').replace(/\s+/g, ' ').trim(),
				wo_url: wo.links?.page || ''
			});
		}

		const meta = json.meta ?? {};
		total = meta.total_count ?? total;
		totalPages = meta.total_pages ?? totalPages;
		console.log(`  page ${pageNum}/${totalPages}: +${json.data?.length ?? 0} (total ${rows.length}${total ? '/' + total : ''})`);
		pageNum++;
	} while (pageNum <= totalPages);

	return rows;
}

function toCsv(rows) {
	if (!rows.length) return '';
	const cols = Object.keys(rows[0]);
	const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
	return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

async function main() {
	const f = parseFlags(process.argv.slice(2));
	const vhost = typeof f.vhost === 'string' ? f.vhost.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
	if (!vhost) {
		console.error('usage: node scripts/appfolio-crawl.mjs --vhost <host.appfolio.com> [--login] [--out <name>] [--page-size <n>]');
		process.exit(1);
	}
	const slug = vhost.split('.')[0];
	const baseUrl = `https://${vhost}`;
	const stateFile = path.join(APPFOLIO_DIR, `.state.${slug}.json`);
	const pageSize = Number(f['page-size']) || 200;

	const chromium = await loadChromium();

	if (f.login || !fs.existsSync(stateFile)) {
		await login(chromium, baseUrl, stateFile);
		if (f.login) return; // login-only run
	}

	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ storageState: stateFile });
	try {
		console.log(`Crawling work orders from ${vhost} (all statuses)…`);
		const rows = await crawlWorkOrders(context.request, baseUrl, pageSize);

		fs.mkdirSync(OUT_DIR, { recursive: true });
		const stamp = new Date().toISOString().slice(0, 10);
		const out = path.join(OUT_DIR, `${typeof f.out === 'string' ? f.out : slug}-${stamp}`);
		fs.writeFileSync(`${out}.csv`, toCsv(rows));
		fs.writeFileSync(`${out}.json`, JSON.stringify(rows, null, 2));

		const withVendor = rows.filter((r) => r.vendor).length;
		console.log(`\n✓ ${rows.length} work orders  (${withVendor} with a vendor assigned)`);
		console.log(`  csv:  ${out}.csv`);
		console.log(`  json: ${out}.json`);
	} catch (err) {
		console.error(`crawl failed: ${err.message}`);
		console.error('if the session expired, re-run with --login');
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main();
