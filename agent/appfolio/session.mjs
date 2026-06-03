// Shared AppFolio browser session helpers — used by worker.mjs (CLI) and
// runner.mjs (step-gated runner). Auth is a session cookie AppFolio drops on
// close, so we persist with Playwright storageState (see README / worker.mjs).
//
// MULTI-ACCOUNT: each customer is a separate AppFolio tenant on its own
// subdomain (lapm.appfolio.com, greenoakpropertymanagement.appfolio.com, …).
// Session state is keyed by that subdomain — .state.<sub>.json — so one
// account's login can never be used to act in another. The runner always
// launches at a workspace's OWN vhost with that vhost's OWN state file; that
// isolation IS the "right account" guarantee.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VHOST = process.env.APPFOLIO_VHOST || 'lapm.appfolio.com';
export const BASE_URL = `https://${VHOST}`;
export const HERE = path.dirname(fileURLToPath(import.meta.url));
// Legacy single-account state (LAPM). Kept so the one-time migration below can
// seed .state.lapm.json without forcing a re-login.
export const STATE_FILE = path.join(HERE, '.state.json');

// Subdomain slug for a vhost: lapm.appfolio.com -> lapm.
export function slugFromVhost(vhost) {
	return String(vhost || '').split('.')[0];
}

// Per-vhost auth state file. Matches the crawler's convention
// (.state.<sub>.json) so logins don't clobber each other across accounts.
export function stateFileFor(vhost) {
	return path.join(HERE, `.state.${slugFromVhost(vhost)}.json`);
}

// One-time migration: the original single-account session lived in .state.json
// (always LAPM). Copy it into the keyed .state.lapm.json so the new per-vhost
// code finds it without a re-login. No-op once the keyed file exists.
export function migrateLegacyState(vhost) {
	if (slugFromVhost(vhost) !== 'lapm') return;
	const keyed = stateFileFor(vhost);
	if (!fs.existsSync(keyed) && fs.existsSync(STATE_FILE)) {
		fs.copyFileSync(STATE_FILE, keyed);
	}
}

export async function loadPlaywright() {
	try {
		const { chromium } = await import('playwright');
		return chromium;
	} catch {
		console.error('\nplaywright not installed: npm i -D playwright && npx playwright install chromium\n');
		process.exit(1);
	}
}

// Fresh browser + context restoring saved auth state. Returns the browser so the
// caller can close it. No profile dir → no cross-process lock.
export async function launch(headless) {
	const chromium = await loadPlaywright();
	const browser = await chromium.launch({ headless });
	const context = await browser.newContext(
		fs.existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {}
	);
	const page = await context.newPage();
	return { browser, context, page };
}

// Workspace-scoped launch: restores the state file for THIS vhost only. Returns
// baseUrl + stateFile alongside the browser so callers navigate/save correctly.
export async function launchFor(vhost, headless) {
	migrateLegacyState(vhost);
	const chromium = await loadPlaywright();
	const stateFile = stateFileFor(vhost);
	const browser = await chromium.launch({ headless });
	const context = await browser.newContext(
		fs.existsSync(stateFile) ? { storageState: stateFile } : {}
	);
	const page = await context.newPage();
	return { browser, context, page, baseUrl: `https://${vhost}`, stateFile };
}

export async function looksLoggedOut(page) {
	// AppFolio holds persistent connections open, so 'networkidle' often never
	// fires — cap the wait so the page (already domcontentloaded) isn't blocked
	// for the full 30s default just to run the login heuristics below.
	await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
	if (/login|sign[_-]?in|sessions/i.test(page.url())) return true;
	if (await page.locator('input[type="password"]').count().catch(() => 0)) return true;
	if (await page.getByRole('button', { name: /log ?in|sign ?in/i }).count().catch(() => 0)) return true;
	return false;
}

// Positive logged-in signal — used to poll past a 2FA challenge (which has
// neither a password field nor a "Log in" button, so looksLoggedOut would be a
// false negative there). The global search box only renders inside the app.
export async function looksLoggedIn(page) {
	await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
	if (await page.getByPlaceholder(/Search AppFolio/i).count().catch(() => 0)) return true;
	// Still on a login / 2FA / SSO page, or a password field present → not in yet.
	if (await page.locator('input[type="password"]').count().catch(() => 0)) return false;
	if (/login|sign[_-]?in|sessions|mfa|otp|two|challenge|verify|account\.appfolio/i.test(page.url()))
		return false;
	return false; // default to "not yet" — only the search box flips us to true
}

// Return the first of several candidate locators to become visible, polling up
// to timeoutMs. Robust to AppFolio's Keycloak login (field is #username, not a
// type=email), so we try labels + ids + types in priority order.
async function firstVisible(page, factories, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	do {
		for (const f of factories) {
			const loc = f().first();
			if (await loc.isVisible().catch(() => false)) return loc;
		}
		await page.waitForTimeout(250);
	} while (Date.now() < deadline);
	return null;
}

// Fill the email + password on AppFolio's login form and submit. Does NOT handle
// 2FA — the caller reads the SMS code (twofa.mjs) and fills it via fill2faCode.
// Throws if the form isn't found. Login lives on a Keycloak realm now
// (account.appfolio.com /realms/property/…), so selectors are deliberately broad.
export async function autoLogin(page, { baseUrl, email, password }) {
	if (!email) throw new Error('no AppFolio login email (workspace alias missing)');
	if (!password) throw new Error('no AppFolio password — set APPFOLIO_PW_<SLUG> in .env');
	await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
	await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
	const emailBox = await firstVisible(
		page,
		[
			() => page.getByLabel(/email/i),
			() => page.locator('#username'),
			() => page.locator('input[name="username" i]'),
			() => page.locator('input[type="email"]'),
			() => page.locator('input[name*="email" i]'),
			() => page.locator('input[autocomplete="username"]')
		],
		15000
	);
	if (!emailBox) throw new Error('login email field not found');
	await emailBox.fill(email);
	const pwBox = await firstVisible(
		page,
		[() => page.getByLabel(/password/i), () => page.locator('input[type="password"]')],
		10000
	);
	if (!pwBox) throw new Error('login password field not found');
	await pwBox.fill(password);
	const btn = page.getByRole('button', { name: /log ?in|sign ?in|continue/i }).first();
	if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
	else if (await page.locator('#kc-login').count().catch(() => 0)) await page.locator('#kc-login').click().catch(() => {});
	else await pwBox.press('Enter').catch(() => {});
	await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// AppFolio shows a "2-Step Verification" chooser AFTER the password — the code
// isn't texted until you pick SMS and click "Send Verification Code". Returns
// that button if we're on the chooser page, else null.
export async function findSendCodeButton(page) {
	const btn = page.getByRole('button', { name: /send verification code/i }).first();
	if (await btn.isVisible().catch(() => false)) return btn;
	const alt = page
		.locator('input[type="submit"][value*="verification" i], button[name*="send" i]')
		.first();
	if (await alt.isVisible().catch(() => false)) return alt;
	return null;
}

// Best-effort: select the SMS delivery option on the chooser (it's the default,
// but make sure we never trigger the phone-call option).
export async function chooseSmsDelivery(page) {
	const r = page.getByRole('radio', { name: /sms|text/i }).first();
	if (await r.count().catch(() => 0)) await r.check().catch(() => {});
}

// The 2FA code-entry input on the post-password page, or null if not present
// yet. Tries common one-time-code selectors (single field). Split-box layouts
// are handled in fill2faCode.
export async function find2faInput(page) {
	const sels = [
		'input[autocomplete="one-time-code"]',
		'input[name="otp"]',
		'#otp',
		'input[name*="code" i]',
		'input[id*="code" i]',
		'input[inputmode="numeric"]',
		'input[type="tel"]'
	];
	for (const s of sels) {
		const loc = page.locator(s).first();
		if (await loc.isVisible().catch(() => false)) return loc;
	}
	return null;
}

// Type the SMS code into the 2FA page (single field or 6 split boxes). Returns
// true if it found somewhere to type it.
export async function fill2faCode(page, code) {
	const single = await find2faInput(page);
	if (single) {
		await single.fill('').catch(() => {});
		await single.pressSequentially(code, { delay: 40 });
		return true;
	}
	const boxes = page.locator('input[maxlength="1"]');
	const n = await boxes.count().catch(() => 0);
	if (n >= code.length) {
		for (let i = 0; i < code.length; i++) await boxes.nth(i).fill(code[i]).catch(() => {});
		return true;
	}
	return false;
}

// Best-effort: tick a "remember/trust this device" box so future logins skip 2FA.
export async function tickRememberDevice(page) {
	for (const re of [/remember/i, /trust this/i, /don.?t ask/i]) {
		const cb = page.getByLabel(re).first();
		if (await cb.count().catch(() => 0)) {
			await cb.check().catch(() => {});
			return;
		}
	}
}

// Submit the 2FA page (a Verify/Continue/Sign-in button, else Enter).
export async function submit2faPage(page) {
	const btn = page.getByRole('button', { name: /verify|submit|continue|confirm|log ?in|sign ?in/i }).first();
	if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
	else if (await page.locator('#kc-login').count().catch(() => 0)) await page.locator('#kc-login').click().catch(() => {});
	else await page.keyboard.press('Enter').catch(() => {});
	await page.waitForLoadState('domcontentloaded').catch(() => {});
}

// Find the WO "Texts" Conversations <select> by content (options read "Name (Role)").
export async function findConversationsSelect(page) {
	const selects = page.locator('select');
	for (let i = 0; i < (await selects.count()); i++) {
		const opts = await selects.nth(i).locator('option').allTextContents();
		if (opts.some((o) => /\((tenant|vendor|owner)\)/i.test(o))) return selects.nth(i);
	}
	return null;
}
