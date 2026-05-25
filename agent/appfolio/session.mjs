// Shared AppFolio browser session helpers — used by worker.mjs (CLI) and
// runner.mjs (step-gated runner). Auth is a session cookie AppFolio drops on
// close, so we persist with Playwright storageState (see README / worker.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VHOST = process.env.APPFOLIO_VHOST || 'lapm.appfolio.com';
export const BASE_URL = `https://${VHOST}`;
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATE_FILE = path.join(HERE, '.state.json');

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

// Find the WO "Texts" Conversations <select> by content (options read "Name (Role)").
export async function findConversationsSelect(page) {
	const selects = page.locator('select');
	for (let i = 0; i < (await selects.count()); i++) {
		const opts = await selects.nth(i).locator('option').allTextContents();
		if (opts.some((o) => /\((tenant|vendor|owner)\)/i.test(o))) return selects.nth(i);
	}
	return null;
}
