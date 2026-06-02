// AppFolio send worker — STEP 1 SPIKE (login-seed + health + recon + send dry-run).
//
// Option 4 ("browser automation") from the send-options decision: a real,
// logged-in AppFolio session drives the WO UI to send tenant / vendor / owner
// messages. This mirrors the iMessage bridge model — hold a session, act through
// it. This file is ONLY the spike: it proves we can hold a session and gives us
// a send surface. The bridge + queue + kill switch + agent tool come later.
//
// AUTH NOTE: AppFolio's session cookie has no expiry (a "session cookie"), which
// Chromium drops on browser close — so a persistent profile dir loses the login.
// We instead capture cookies+storage with Playwright `storageState` into a JSON
// file and restore them each launch. That survives close and needs no profile
// lock (so commands can run concurrently).
//
// Commands:
//   node agent/appfolio/worker.mjs login    # headed: human logs in once, state saved to .state.json
//   node agent/appfolio/worker.mjs health   # headless: is the saved session still logged in?
//   node agent/appfolio/worker.mjs diag [url]   # dump what the worker sees (debug)
//   node agent/appfolio/worker.mjs record [url] # headed + Inspector: capture selectors
//   node agent/appfolio/worker.mjs send --url <u> --to <who> --message <m> [--live]
//
// Setup (once, on the Mac mini): npm i -D playwright && npx playwright install chromium

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VHOST = process.env.APPFOLIO_VHOST || 'lapm.appfolio.com';
const BASE_URL = `https://${VHOST}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Saved auth state (cookies + localStorage). Gitignored — it's login-equivalent.
const STATE_FILE = path.join(HERE, '.state.json');

async function loadPlaywright() {
	try {
		const { chromium } = await import('playwright');
		return chromium;
	} catch {
		console.error(
			'\nplaywright not installed. On the Mac mini run:\n' +
				'  npm i -D playwright && npx playwright install chromium\n'
		);
		process.exit(1);
	}
}

// Fresh browser + context, restoring saved auth state if we have it. Returns the
// browser too so callers can close it (closing the browser, not just the context,
// is what fully tears down). No shared profile dir → no cross-command lock.
async function launch(headless) {
	const chromium = await loadPlaywright();
	const browser = await chromium.launch({ headless });
	const context = await browser.newContext(
		fs.existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {}
	);
	const page = await context.newPage();
	return { browser, context, page };
}

function waitForEnter(prompt) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

// Logged-out detection by negative signals only — a login URL, a password field,
// or a sign-in button. Deliberately avoids "positive" checks that could wrongly
// block a valid session.
async function looksLoggedOut(page) {
	await page.waitForLoadState('networkidle').catch(() => {});
	if (/login|sign[_-]?in|sessions/i.test(page.url())) return true;
	if (await page.locator('input[type="password"]').count().catch(() => 0)) return true;
	if (await page.getByRole('button', { name: /log ?in|sign ?in/i }).count().catch(() => 0)) return true;
	return false;
}

async function login() {
	const { browser, context, page } = await launch(false);
	await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
	console.log(
		`\nA browser opened at ${BASE_URL}.\n` +
			'Log in fully (including 2FA). This is a HUMAN task — never automate it.\n' +
			'When the dashboard is loaded, come back here and press Enter to save the session.\n'
	);
	await waitForEnter('Press Enter once logged in… ');
	if (await looksLoggedOut(page)) {
		console.log('⚠️  still looks logged out — NOT saving. Finish logging in and re-run `login`.');
	} else {
		await context.storageState({ path: STATE_FILE });
		console.log(`✓ session saved to ${STATE_FILE}`);
	}
	await browser.close();
}

async function health() {
	const { browser, page } = await launch(true);
	await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
	const out = await looksLoggedOut(page);
	console.log(out ? 'LOGGED OUT — run `login` to re-seed the session' : 'LOGGED IN — session is live');
	await browser.close();
	process.exit(out ? 1 : 0);
}

// Dump what the worker actually sees — to tell a persistence problem (real login
// wall) apart from a detection bug.
async function diag(url) {
	const { browser, context, page } = await launch(true);
	await page.goto(url || BASE_URL, { waitUntil: 'domcontentloaded' });
	await page.waitForLoadState('networkidle').catch(() => {});
	console.log(
		JSON.stringify(
			{
				finalUrl: page.url(),
				title: await page.title().catch(() => ''),
				passwordFields: await page.locator('input[type="password"]').count().catch(() => 0),
				searchAppFolioBox: await page.getByPlaceholder(/Search AppFolio/i).count().catch(() => 0),
				enterMessageBox: await page.getByPlaceholder('Enter message').count().catch(() => 0),
				cookies: (await context.cookies()).length
			},
			null,
			2
		)
	);
	const shot = path.join(HERE, `diag-${Date.now()}.png`);
	await page.screenshot({ path: shot });
	console.log('shot:', shot);
	await browser.close();
}

// Recon: open the logged-in session at a WO and hand control to the Playwright
// Inspector to capture selectors. SAFETY: read selectors up to Send — don't click
// final Send on a real recipient.
async function record(url) {
	const { browser, page } = await launch(false);
	await page.goto(url || BASE_URL, { waitUntil: 'domcontentloaded' });
	if (await looksLoggedOut(page)) {
		console.error('Not logged in — run `login` first.');
		await browser.close();
		process.exit(1);
	}
	console.log('\n=== RECON MODE === navigate to a decoy WO, use "Pick locator". Do NOT click final Send.\n');
	await page.pause();
	await browser.close();
}

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

// Free-text send through the WO "Texts" widget. ONE widget serves both tenant
// and vendor — the `Conversations` dropdown picks who. That dropdown is the
// wrong-person risk, so recipient selection is a hard interlock: exactly one
// option must match `--to`, else we abort without touching anything.
//
//   send --url <wo-url> --to "Tenant|Vendor|<name>" --message "..." [--live]
//
// Default is a DRY RUN: fills recipient + message, screenshots, does NOT click
// Send. Safe against a real WO. Only ever --live against a decoy recipient.
async function send(argv) {
	const f = parseFlags(argv);
	if (!f.url || !f.to || !f.message) {
		console.error('usage: send --url <wo-url> --to "<name|Tenant|Vendor>" --message "..." [--live]');
		process.exit(1);
	}
	const live = f.live === true;
	const { browser, page } = await launch(false);
	try {
		await page.goto(f.url, { waitUntil: 'domcontentloaded' });
		if (await looksLoggedOut(page)) {
			console.error('Not logged in — run `login` first.');
			return;
		}

		// Expand the Texts section if needed (clicking the header toggles it, so only
		// click when the message box isn't already showing — the widget lazy-loads).
		const box = page.getByPlaceholder('Enter message');
		if (!(await box.isVisible().catch(() => false))) {
			await page.getByText('Texts', { exact: true }).first().click().catch(() => {});
		}
		await box.waitFor({ state: 'visible', timeout: 15000 });

		// Find the Conversations <select> by content: options look like "Name (Role)".
		// If none match, the widget is a custom dropdown — bail loudly so we re-tool.
		const selects = page.locator('select');
		let conversations = null;
		let allOptions = [];
		for (let i = 0; i < (await selects.count()); i++) {
			const opts = await selects.nth(i).locator('option').allTextContents();
			if (opts.some((o) => /\((tenant|vendor|owner)\)/i.test(o))) {
				conversations = selects.nth(i);
				allOptions = opts;
				break;
			}
		}
		if (!conversations) {
			console.error('Could not find a native Conversations <select> — likely a custom dropdown. Aborting.');
			await page.screenshot({ path: path.join(HERE, `debug-${Date.now()}.png`) });
			return;
		}

		// Interlock: exactly one option may match `--to`.
		const matches = allOptions.filter((o) => o.toLowerCase().includes(String(f.to).toLowerCase()));
		if (matches.length !== 1) {
			console.error(
				`recipient "${f.to}" matched ${matches.length} of [ ${allOptions.join(' | ')} ] — aborting`
			);
			return;
		}
		await conversations.selectOption({ label: matches[0] });
		await box.fill(f.message);

		// Scroll the message box (bottom of the thread) into view so the screenshot
		// actually shows the message / the newly-sent line, not the top of the thread.
		const shot = path.join(HERE, `last-send-${Date.now()}.png`);
		await box.scrollIntoViewIfNeeded().catch(() => {});
		if (!live) {
			await page.screenshot({ path: shot });
			console.log(
				`DRY RUN — filled but did NOT click Send.\n  recipient: ${matches[0]}\n  message:   ${f.message}\n  shot:      ${shot}`
			);
			return;
		}
		await page.getByRole('button', { name: 'Send', exact: true }).click();
		await page.waitForTimeout(1500);
		await box.scrollIntoViewIfNeeded().catch(() => {});
		await page.screenshot({ path: shot });
		console.log(`SENT to ${matches[0]}.\n  shot: ${shot}`);
	} catch (err) {
		console.error(`send failed: ${err.message}`);
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

// Dump clickable elements whose text contains --text (default "Edit") with their
// tag / href / class — to pin a selector without guessing.
async function probe(argv) {
	const f = parseFlags(argv);
	const url = f.url || `${BASE_URL}/maintenance/service_requests/${f.srn}`;
	const term = (f.text || 'Edit').toLowerCase();
	const { browser, page } = await launch(true);
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		await page.waitForLoadState('networkidle').catch(() => {});
		const found = await page.evaluate((term) => {
			const out = [];
			for (const el of document.querySelectorAll('a,button,[role="button"]')) {
				const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
				if (t.toLowerCase().includes(term) && t.length < 60) {
					out.push({ tag: el.tagName, href: el.getAttribute('href'), cls: (el.className || '').slice(0, 70), text: t });
				}
			}
			return out;
		}, term);
		console.log('finalUrl:', page.url());
		console.log(JSON.stringify(found, null, 2));
	} finally {
		await browser.close();
	}
}

// Assign a vendor on a WO via the Edit form's Vendor typeahead (a custom search
// dropdown, not a native select). DRY by default: selects the vendor but NEVER
// checks the secure-link boxes and NEVER clicks Save — just fills + screenshots.
// Interlock: the picked option must contain --vendor, else abort.
//
//   set-vendor --srn 7665 --vendor "JL Unlimited Services"   (add --url to override)
async function setVendor(argv) {
	const f = parseFlags(argv);
	if ((!f.srn && !f.url) || !f.vendor) {
		console.error('usage: set-vendor --srn <n> --vendor "<name>" [--url <wo-url>]');
		process.exit(1);
	}
	const url = f.url || `${BASE_URL}/maintenance/service_requests/${f.srn}`;
	const { browser, page } = await launch(false);
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		if (await looksLoggedOut(page)) {
			console.error('Not logged in — run `login` first.');
			return;
		}
		// Enter edit mode via the WO's Edit control. It's a JS link with no href
		// (class js-edit-work-order) — distinct from the Service Request's js-edit,
		// and not a "link" role, which is why a role-based selector missed it.
		await page.locator('.js-edit-work-order').first().click();

		// The Vendor field is a Select2 (v3) widget: the real <input
		// id=maintenance_work_order_party> is hidden until you open it. Click the
		// rendered choice to open the dropdown, type into the live search, then pick.
		const opener = page.locator('#s2id_maintenance_work_order_party');
		await opener.waitFor({ state: 'visible', timeout: 15000 });
		await opener.scrollIntoViewIfNeeded();
		await opener.click();
		const live = page.locator('#select2-drop input').first();
		await live.waitFor({ state: 'visible', timeout: 10000 });
		await live.pressSequentially(f.vendor, { delay: 60 });
		await page.waitForTimeout(1500);

		// Interlock: pick a result containing the requested vendor name.
		const results = page.locator('#select2-drop .select2-results li');
		const texts = (await results.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
		const matches = texts.filter((t) => t.toLowerCase().includes(f.vendor.toLowerCase()));
		if (matches.length === 0) {
			console.error(`no vendor result matched "${f.vendor}" — aborting (not saved). saw: [ ${texts.join(' | ')} ]`);
			await page.screenshot({ path: path.join(HERE, `debug-${Date.now()}.png`) });
			return;
		}
		await results.filter({ hasText: f.vendor }).first().click();
		await page.waitForTimeout(1000);

		const shot = path.join(HERE, `set-vendor-${Date.now()}.png`);
		await page.screenshot({ path: shot, fullPage: true });
		console.log(
			`DRY — picked vendor "${matches[0]}" (${matches.length} of [ ${texts.join(' | ')} ]). ` +
				`No boxes checked, NOT saved.\n  shot: ${shot}`
		);
	} catch (err) {
		console.error(`set-vendor failed (nothing saved): ${err.message}`);
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

// Open a WO headed and hold it visible so a human can watch. Accepts a bare SRN
// (resolved via the service_requests redirect) or a full URL.
async function openIssue(srnOrUrl, seconds) {
	const url = /^https?:/i.test(srnOrUrl || '')
		? srnOrUrl
		: `${BASE_URL}/maintenance/service_requests/${srnOrUrl}`;
	const { browser, page } = await launch(false);
	await page.goto(url, { waitUntil: 'domcontentloaded' });
	console.log(`opened ${page.url()} — holding ${seconds}s so you can watch…`);
	await page.waitForTimeout(seconds * 1000);
	await browser.close();
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
	login: () => login(),
	health: () => health(),
	diag: () => diag(rest[0]),
	open: () => openIssue(rest[0], Number(rest[1]) || 20),
	record: () => record(rest[0]),
	send: () => send(rest),
	'set-vendor': () => setVendor(rest),
	probe: () => probe(rest)
};
const run = commands[cmd];
if (!run) {
	console.error(
		'usage: worker.mjs <login | health | diag [url] | open <srn|url> [secs] | record [url] | set-vendor --srn <n> --vendor <name> | send --url <u> --to <who> --message <m> [--live]>'
	);
	process.exit(1);
}
run();
