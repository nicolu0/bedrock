// AppFolio runner — SERVICE mode. Holds one logged-in Chromium and a local panel
// (http://localhost:9773). The runner owns the whole flow and executes every
// step internally. The panel is now only a monitor / stop surface.
//
// A run is started either from the CLI (back-compat) or by loading the panel URL
// with query params (how agent/ui embeds it via an <iframe>):
//   http://localhost:9773/?flow=text&issue_id=<uuid>&to=Tenant&message=<text>
//   http://localhost:9773/?flow=vendor&srn=7665&vendor=JL%20Unlimited%20Services
// An optional &workspace=<uuid> pins the account; otherwise the runner resolves
// it from issue_id (issues_v2.workspace_id), defaulting to LAPM.
//
// MULTI-ACCOUNT + AUTO-LOGIN: each workspace is a separate AppFolio tenant on
// its own subdomain. The runner picks the vhost / session-state / login creds
// for the run's workspace (session.mjs keys state per vhost) so it can never act
// in the wrong account. If the saved session has expired, the "Open" step
// reports `needs_login` instead of dying; the panel's "Log in to AppFolio"
// button auto-fills email (workspace alias) + password (APPFOLIO_PW_<SLUG> from
// .env) in a HEADED window, the human types the 2FA code, and the run resumes.
//
// CLI (same as before):
//   node agent/appfolio/runner.mjs --flow vendor --srn 7665 --vendor "JL Unlimited Services"

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
	HERE,
	launchFor,
	looksLoggedOut,
	looksLoggedIn,
	autoLogin,
	findSendCodeButton,
	chooseSmsDelivery,
	find2faInput,
	fill2faCode,
	submit2faPage,
	tickRememberDevice,
	stateFileFor,
	slugFromVhost,
	findConversationsSelect
} from './session.mjs';
import { readLatestAppfolioCode } from './twofa.mjs';
import { acquireLoginLock, releaseLoginLock, clearOwnStaleLock } from './login-lock.mjs';
import { supabaseEnv } from '../core/supabase.mjs';
import { appfolioVhostFor } from '../core/workspaces.mjs';

// Fallback account when no workspace is pinned (legacy single-runner default).
const LAPM_ID = '2e4373a0-40b8-42c2-a873-b08c99dbf76a';
// This process serves EXACTLY ONE workspace. server.mjs spawns one runner per
// AppFolio workspace, pinning its id + port via env. The runner refuses any
// request for a different workspace — process isolation is the cross-account
// safety boundary (one process only ever holds one account's login).
const RUNNER_WS_ID = process.env.RUNNER_WORKSPACE_ID || LAPM_ID;
const PORT = Number(process.env.RUNNER_PORT) || 9773;
// Everything runs HEADLESS — runs and login both. The panel's live screencast is
// the view, so no Chromium window pops over your screen. Login fills email+pw and
// reads the texted 2FA code from chat.db, completing invisibly. Set
// APPFOLIO_HEADED=1 to launch a real window for debugging.
const HEADED = !!process.env.APPFOLIO_HEADED;
// Background keepalive: touch an authenticated page on this cadence so AppFolio's
// idle timeout never fires → the session stays warm → we rarely re-login (and
// rarely 2FA). Under any plausible AppFolio idle window. APPFOLIO_KEEPALIVE_MS=0
// disables it.
const KEEPALIVE_MS =
	process.env.APPFOLIO_KEEPALIVE_MS === '0'
		? 0
		: Number(process.env.APPFOLIO_KEEPALIVE_MS) || 10 * 60 * 1000;
// Drop a leftover login lock from this port's previous (killed) incarnation so a
// restart mid-login doesn't block the next login until the lock ages out.
clearOwnStaleLock(PORT);

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function parseFlags(argv) {
	const f = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) continue;
		const k = argv[i].slice(2);
		const v = argv[i + 1];
		if (v === undefined || v.startsWith('--')) f[k] = true;
		else { f[k] = v; i++; }
	}
	return f;
}

// ---- Supabase lookups ----------------------------------------------------

function sbHeaders() {
	const { key } = supabaseEnv();
	return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };
}

async function resolveSrn(issue_id) {
	const { url } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/issues_v2?id=eq.${issue_id}&select=appfolio_srn`, {
		headers: sbHeaders()
	});
	if (!res.ok) throw new Error(`resolveSrn: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows?.[0]?.appfolio_srn;
}

async function workspaceIdFromIssue(issue_id) {
	const { url } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/issues_v2?id=eq.${issue_id}&select=workspace_id`, {
		headers: sbHeaders()
	});
	if (!res.ok) return null;
	const rows = await res.json();
	return rows?.[0]?.workspace_id ?? null;
}

async function fetchWorkspaceRow(id) {
	const { url } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/workspaces?id=eq.${id}&select=slug,alias`, {
		headers: sbHeaders()
	});
	if (!res.ok) return null;
	const rows = await res.json();
	return rows?.[0] ?? null;
}

// Resolve the full AppFolio identity for THIS runner's pinned workspace: which
// account (vhost), where its session lives (stateFile), and how to log in
// (email = workspace alias, password = APPFOLIO_PW_<SLUG> in .env). Resolved once
// and cached — this process never serves any other account.
let wsCache = null;
async function getWorkspace() {
	if (wsCache) return wsCache;
	const id = RUNNER_WS_ID;
	const vhost = appfolioVhostFor(id) || process.env.APPFOLIO_VHOST || 'lapm.appfolio.com';
	const row = (await fetchWorkspaceRow(id).catch(() => null)) || {};
	const slug = row.slug || slugFromVhost(vhost);
	const ENV = slug.toUpperCase().replace(/[^A-Z0-9]/g, '');
	const email = process.env[`APPFOLIO_EMAIL_${ENV}`] || row.alias || '';
	const password = process.env[`APPFOLIO_PW_${ENV}`] || '';
	wsCache = {
		id,
		slug,
		vhost,
		baseUrl: `https://${vhost}`,
		stateFile: stateFileFor(vhost),
		email,
		password
	};
	return wsCache;
}

// ---- flows: each step { name, gate?, run(page) } -------------------------

function openStep(srn, baseUrl) {
	return {
		name: `Open work order #${srn}`,
		run: async (p) => {
			await p.goto(`${baseUrl}/maintenance/service_requests/${srn}`, { waitUntil: 'domcontentloaded' });
			// Sentinel: runNext maps NEEDS_LOGIN to the recoverable `needs_login`
			// state (offer auto-login) rather than a dead error.
			if (await looksLoggedOut(p)) throw new Error('NEEDS_LOGIN');
		}
	};
}

// Shared "Texts" steps (used by the standalone text flow and the tail of the
// vendor-dispatch flow). None of these commit — Fill just types into the box.
const expandTextsStep = () => ({
	name: 'Expand Texts',
	run: async (p) => {
		const box = p.getByPlaceholder('Enter message');
		if (!(await box.isVisible().catch(() => false))) {
			await p.getByText('Texts', { exact: true }).first().click().catch(() => {});
		}
		await box.waitFor({ state: 'visible', timeout: 15000 });
	}
});

const selectConversationStep = (to) => ({
	name: `Select conversation → ${to}`,
	run: async (p) => {
		const sel = await findConversationsSelect(p);
		if (!sel) throw new Error('Conversations select not found (custom dropdown?)');
		const opts = await sel.locator('option').allTextContents();
		const m = opts.filter((o) => o.toLowerCase().includes(String(to).toLowerCase()));
		if (m.length !== 1) throw new Error(`recipient "${to}" matched ${m.length} of [ ${opts.join(' | ')} ]`);
		await sel.selectOption({ label: m[0] });
	}
});

const fillMessageStep = (message) => ({
	name: 'Fill message',
	run: async (p) => { await p.getByPlaceholder('Enter message').fill(message); }
});

// LIVE send — clicks the real Send button in the Texts widget.
const sendStep = () => ({
	name: 'Send — texts the recipient (LIVE)',
	run: async (p) => {
		await p.getByRole('button', { name: 'Send', exact: true }).click();
		await p.waitForTimeout(1200);
	}
});

// Standalone messaging: open → expand Texts → pick the conversation → fill →
// SEND (LIVE). Like the vendor flow, the final Send genuinely texts the
// recipient; every step still needs an explicit approval before it runs.
function textFlow({ srn, to, message, baseUrl }) {
	return [
		openStep(srn, baseUrl),
		expandTextsStep(),
		selectConversationStep(to),
		fillMessageStep(message),
		sendStep()
	];
}

// Combined vendor dispatch (LIVE — authorized for real usage):
// open → edit → pick vendor → tick Text+Email secure-link boxes → SAVE (assigns
// the vendor and fires the secure link) → expand Texts → pick the Vendor
// conversation → fill the free-text message → SEND. Each step still needs an
// explicit approval; Save and Send genuinely commit.
function vendorFlow({ srn, vendor, message, baseUrl }) {
	return [
		openStep(srn, baseUrl),
		{
			name: 'Click Edit',
			run: async (p) => {
				await p.locator('.js-edit-work-order').first().click();
				await p.locator('#s2id_maintenance_work_order_party').waitFor({ state: 'visible', timeout: 15000 });
			}
		},
		{
			name: `Select vendor → ${vendor}`,
			run: async (p) => {
				const opener = p.locator('#s2id_maintenance_work_order_party');
				await opener.scrollIntoViewIfNeeded();
				await opener.click();
				const live = p.locator('#select2-drop input').first();
				await live.waitFor({ state: 'visible', timeout: 10000 });
				await live.pressSequentially(vendor, { delay: 60 });
				await p.waitForTimeout(1500);
				const results = p.locator('#select2-drop .select2-results li');
				const texts = (await results.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
				const m = texts.filter((t) => t.toLowerCase().includes(String(vendor).toLowerCase()));
				if (m.length === 0) throw new Error(`vendor "${vendor}" matched 0 of [ ${texts.join(' | ')} ]`);
				await results.filter({ hasText: vendor }).first().click();
			}
		},
		{
			name: 'Tick secure-link boxes (Text + Email)',
			run: async (p) => {
				// These appear only after a vendor is selected (the prior step).
				for (const id of [
					'#maintenance_work_order_send_vendor_text',
					'#maintenance_work_order_send_vendor_wo_link'
				]) {
					const box = p.locator(id);
					await box.waitFor({ state: 'visible', timeout: 10000 });
					await box.check();
				}
			}
		},
		{
			name: 'Save — assigns vendor + sends secure link (LIVE)',
			run: async (p) => {
				await p.locator('#save_button').click();
				await p.waitForLoadState('domcontentloaded').catch(() => {});
				// Wait for the WO view to re-render after the save round-trip.
				await p
					.getByText('Texts', { exact: true })
					.first()
					.waitFor({ state: 'visible', timeout: 20000 })
					.catch(() => {});
			}
		},
		expandTextsStep(),
		selectConversationStep('Vendor'),
		fillMessageStep(message),
		sendStep()
	];
}

// ---- run state (one run at a time) ---------------------------------------

// Live-screencast state (CDP → motion JPEG). Declared up here so ensurePage()
// can reset/re-attach the stream when the browser is relaunched.
let cdp = null;
let lastFrame = null;
const streamClients = new Set();

// Browser session for this runner's ONE account. Relaunchable: ensurePage tears
// it down and relaunches only when the headed/headless mode changes (login goes
// headed for 2FA), restoring this account's saved session state. The vhost never
// changes — this process is pinned to a single workspace.
let browser, context, page;
let curHeaded = null;
let curWs = null; // resolved workspace (vhost/creds/stateFile) — always RUNNER_WS_ID
let loginPoll = null;
let curDraftId = null; // draft this run is sending for (send-once guard key)

// Send-once guard (defense in depth behind the UI's server-side claim lock): this
// process physically clicks Send, so it also remembers which drafts it has already
// sent LIVE and refuses to send them again. draft_id → ISO time of the completed
// send. In-memory only — the durable per-draft lock lives in the drafts file; this
// catches a duplicate within the same runner process (UI bypass, or a ghost send
// that landed but reported error, then got retried). Unbounded but tiny.
const sentDrafts = new Map();

async function ensurePage(headed) {
	const ws = await getWorkspace();
	const alive = page && !page.isClosed() && browser?.isConnected?.();
	if (alive && curHeaded === headed) return false;
	if (browser?.isConnected?.()) await browser.close().catch(() => {});
	const fresh = await launchFor(ws.vhost, !headed); // launchFor takes headless; headed = !headless
	browser = fresh.browser;
	context = fresh.context;
	page = fresh.page;
	curHeaded = headed;
	cdp = null; // any prior screencast died with the old page
	if (streamClients.size) await ensureScreencast().catch(() => {});
	return true;
}

let flow = [];
let steps = []; // {name, gate} for the panel
let flowName = 'text';
let idx = 0;
let status = 'idle'; // idle | starting | ready | running | paused | gated | needs_login | logging_in | verifying_2fa | error | done
let error = null;
let shotTs = 0;
let busy = false;
let autoRun = false;
let autoBusy = false;
let sig = null;
let keepAliveBusy = false; // true while a keepalive ping holds the page

async function snapshot() {
	if (!page || page.isClosed()) return;
	await page.screenshot({ path: path.join(HERE, 'run-current.png') }).catch(() => {});
	shotTs = Date.now();
}

// ---- live screencast (CDP → motion JPEG) ---------------------------------
// Pure observation: stream the page surface to the panel as MJPEG so the UI
// shows a live view instead of per-step stills. Started lazily on the first
// /stream client; frames broadcast to every open <img> connection. No deps,
// no WebSocket — a plain <img src="/stream"> renders multipart/x-mixed-replace.

function writeFrame(res, buf) {
	res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
	res.write(buf);
	res.write('\r\n');
}

async function ensureScreencast() {
	if (cdp || !page) return;
	cdp = await page.context().newCDPSession(page);
	await cdp.send('Page.startScreencast', {
		format: 'jpeg',
		quality: 55,
		maxWidth: 1400,
		maxHeight: 900,
		everyNthFrame: 1
	});
	cdp.on('Page.screencastFrame', async (e) => {
		await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
		lastFrame = Buffer.from(e.data, 'base64');
		for (const res of streamClients) {
			try {
				writeFrame(res, lastFrame);
			} catch {
				streamClients.delete(res);
			}
		}
	});
}

async function startRun(params) {
	// Let an in-flight keepalive ping finish so we don't navigate the page out from
	// under it (keepalive yields the page back within a couple seconds).
	for (let i = 0; i < 50 && keepAliveBusy; i++) await sleep(100);
	// SAFETY: this runner serves exactly one account. Refuse a misrouted request
	// — both an explicit foreign workspace and an issue that belongs elsewhere.
	if (params.workspace && params.workspace !== RUNNER_WS_ID) {
		throw new Error(`workspace ${params.workspace} not served by this runner (${RUNNER_WS_ID})`);
	}
	if (params.issue_id) {
		const wid = await workspaceIdFromIssue(params.issue_id).catch(() => null);
		if (wid && wid !== RUNNER_WS_ID) {
			throw new Error(`issue belongs to ${wid}, not this runner's workspace (${RUNNER_WS_ID})`);
		}
	}
	curDraftId = params.draft_id || null;
	flowName = params.flow === 'vendor' ? 'vendor' : 'text';
	// Send-once: if this exact draft already completed a LIVE send in this process,
	// short-circuit to 'done' WITHOUT re-running the flow — no second Send click.
	// The UI then resolves the draft normally (appfolio-done) and nothing re-sends.
	if (curDraftId && sentDrafts.has(curDraftId)) {
		steps = [{ name: 'Already sent — skipped (duplicate)', gate: false }];
		idx = 1;
		status = 'done';
		error = null;
		await snapshot();
		return;
	}
	autoRun = params.auto !== '0' && params.auto !== 'false';
	steps = []; // clear any prior run so a failed start shows a clean error
	idx = 0;
	status = 'starting';
	error = null;
	const ws = await getWorkspace();
	curWs = ws;
	loginAttempts = 0; // fresh run → allow auto-login again
	let srn = params.srn;
	if (!srn && params.issue_id) srn = await resolveSrn(params.issue_id);
	if (!srn) throw new Error('no srn (and issue_id did not resolve to appfolio_srn)');
	await ensurePage(HEADED); // headless by default
	flow =
		flowName === 'vendor'
			? vendorFlow({ srn, vendor: params.vendor, message: params.message || '', baseUrl: ws.baseUrl })
			: textFlow({ srn, to: params.to || 'Tenant', message: params.message || '', baseUrl: ws.baseUrl });
	steps = flow.map((s) => ({ name: s.name, gate: !!s.gate }));
	idx = 0;
	status = 'ready';
	error = null;
	await snapshot();
	// Auto-run the first step (open the WO) so the browser navigates to the work
	// order the moment the run starts. In auto mode, keep going through the full
	// committed flow; auto mode is now the default.
	if (autoRun) await runUntilDone();
	else await runNext();
}

async function runUntilDone() {
	if (autoBusy) return;
	autoBusy = true;
	try {
		while (autoRun && (status === 'ready' || status === 'paused')) {
			await runNext();
			if (status === 'ready' || status === 'paused') await sleep(250);
		}
	} finally {
		autoBusy = false;
	}
}

async function runNext() {
	if (busy || status === 'idle') return;
	// Don't advance mid-login — running a step would navigate away from the login
	// page while we're filling email/password or the texted 2FA code.
	if (status === 'logging_in' || status === 'verifying_2fa') return;
	if (idx >= flow.length || flow[idx].gate) { status = 'gated'; return; }
	busy = true;
	status = 'running';
	try {
		await flow[idx].run(page);
		await snapshot();
		idx++;
		status = idx >= flow.length ? 'done' : flow[idx].gate ? 'gated' : 'paused';
		// Flow complete = the final LIVE Send/Save just ran. Record this draft so a
		// retry of the same draft is refused (send-once guard).
		if (status === 'done' && curDraftId) sentDrafts.set(curDraftId, new Date().toISOString());
	} catch (e) {
		if (e.message === 'NEEDS_LOGIN') {
			// Recoverable: leave idx on the open step so it re-runs after login.
			status = 'needs_login';
			error = curWs ? `Logged out of ${curWs.slug} — signing in…` : 'Logged out of AppFolio';
		} else {
			error = e.message;
			status = 'error';
		}
		await snapshot();
	} finally {
		busy = false;
	}
	// Auto-login the moment we detect a logged-out session — no button click. The
	// attempt cap stops an infinite loop if login keeps not "taking".
	if (status === 'needs_login' && loginAttempts < 2) {
		loginAttempts++;
		startLogin().catch((err) => { error = err.message; status = 'error'; });
	}
}

// ---- auto-login (fully headless; 2FA code read from chat.db) -----------------

let submitTimeMs = 0;
let loginAttempts = 0;

function stopLoginPoll() {
	if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
}

async function failLogin(msg, st = 'error') {
	stopLoginPoll();
	releaseLoginLock();
	error = msg;
	status = st;
	await snapshot();
}

// Headless auto-login. Fires automatically when a run finds the session logged
// out (and re-runnable via the panel button). Fills email+password, then reads
// the texted 2FA code from chat.db and submits it — no window, no human, no
// click. Set APPFOLIO_HEADED=1 to watch it in a real window for debugging.
async function startLogin() {
	if (!curWs) return failLogin('no active run to log in for');
	if (!curWs.email) return failLogin(`no login email for ${curWs.slug} (workspace alias missing)`);
	if (!curWs.password) {
		return failLogin(`no password — set APPFOLIO_PW_${curWs.slug.toUpperCase().replace(/[^A-Z0-9]/g, '')} in .env`);
	}
	status = 'logging_in';
	await snapshot();
	// Serialize logins across all workspace runners: only one account may have a
	// login (and thus an inbound 2FA SMS) in flight at a time, so the texted code
	// we read can only be ours. Rare event, ~30s, so the wait costs nothing.
	const got = await acquireLoginLock({ workspace: curWs.slug, port: PORT });
	if (!got) return failLogin('another AppFolio login is in progress — retry shortly', 'needs_login');
	try {
		await ensurePage(HEADED); // headless by default — invisible end to end
		submitTimeMs = Date.now();
		await autoLogin(page, curWs);
	} catch (e) {
		return failLogin(`auto-login failed: ${e.message}`, 'needs_login');
	}
	status = 'verifying_2fa';
	error = null;
	await snapshot();
	startLoginPoll();
}

// Poll until logged in: read the texted code from chat.db, fill it, submit, tick
// remember-device. Re-attempts every ~12s in case the first SMS lagged. On
// success: assert the right account, persist the session, resume the run. Caps
// at ~150s → needs_login (the panel button retries; APPFOLIO_HEADED=1 to debug).
function startLoginPoll() {
	stopLoginPoll();
	const started = Date.now();
	let lastFillAt = 0;
	let codeRequested = false;
	loginPoll = setInterval(async () => {
		if (status !== 'verifying_2fa') return stopLoginPoll();
		let inNow = false;
		try { inNow = await looksLoggedIn(page); } catch { /* mid-navigation */ }
		if (inNow) { stopLoginPoll(); return finishLogin(); }
		try {
			// Step A: the "2-Step Verification" chooser — pick SMS and click "Send
			// Verification Code" ONCE to trigger the text (the code-entry field only
			// appears after this). Reset the freshness gate to this moment.
			if (!codeRequested) {
				const sendBtn = await findSendCodeButton(page);
				if (sendBtn) {
					await chooseSmsDelivery(page).catch(() => {});
					await sendBtn.click().catch(() => {});
					codeRequested = true;
					submitTimeMs = Date.now(); // the SMS is sent now
					await snapshot();
					return;
				}
			}
			// Step B: code-entry page — read the texted code, fill it, submit.
			if (await find2faInput(page)) {
				const hit = readLatestAppfolioCode(submitTimeMs);
				if (hit && Date.now() - lastFillAt > 12000) {
					lastFillAt = Date.now();
					await tickRememberDevice(page).catch(() => {});
					await fill2faCode(page, hit.code);
					await submit2faPage(page);
					await snapshot();
				}
			}
		} catch { /* keep polling */ }
		if (Date.now() - started > 150000) {
			return failLogin('auto-login timed out (no 2FA code seen?) — retry via the button', 'needs_login');
		}
	}, 2000);
}

async function finishLogin() {
	releaseLoginLock(); // logged in → the SMS-triggering window is over, free the slot
	try {
		// Right-account guard: a successful login MUST land on this workspace's own
		// subdomain. Combined with per-vhost state files, this makes acting in the
		// wrong account impossible.
		const host = new URL(page.url()).host;
		if (host !== curWs.vhost && !host.endsWith(`.${curWs.vhost}`)) {
			error = `logged in on ${host}, expected ${curWs.vhost} — aborting (wrong account)`;
			status = 'error';
			await snapshot();
			return;
		}
		await context.storageState({ path: curWs.stateFile });
	} catch (e) {
		error = `saving session failed: ${e.message}`;
		status = 'error';
		await snapshot();
		return;
	}
	// Logged in (headed). Re-run from the open step and continue the run normally;
	// every commit step still gates on its own approval.
	idx = 0;
	status = 'ready';
	error = null;
	await snapshot();
	if (autoRun) await runUntilDone();
	else await runNext();
}

// CLI back-compat: --flow on the command line starts a run at boot.
const cli = parseFlags(process.argv.slice(2));
if (cli.flow) startRun(cli).catch((e) => { error = e.message; status = 'error'; });

// ---- panel + control endpoints -------------------------------------------

const SHELL = `<!doctype html><meta charset=utf-8><title>AppFolio runner</title>
<style>
 body{margin:0;background:#16161a;color:#e8e8e6;font:14px/1.5 -apple-system,system-ui,sans-serif}
 .wrap{max-width:560px;margin:0 auto;padding:16px}
 h1{font-size:15px;margin:0 0 2px} .sub{color:#9a9a96;margin:0 0 14px;font-size:12px}
 ol{padding:0;list-style:none;margin:0 0 14px}
 li{display:flex;gap:9px;align-items:center;padding:7px 10px;border:1px solid #2c2c32;border-radius:8px;margin-bottom:5px;background:#1d1d22;font-size:13px}
 .dot{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;flex:0 0 18px}
 .done .dot{background:#1f883d;color:#fff}.cur .dot{background:#a48bff;color:#fff}
 .gate .dot{background:#d29922;color:#16161a}.pend .dot{background:#2c2c32;color:#9a9a96}
 .cur{border-color:#a48bff}.gate{border-color:#d29922} .nm{flex:1}.gate .nm{color:#d29922}
 img{width:100%;border:1px solid #2c2c32;border-radius:9px;display:block;margin-bottom:10px}
 .bar{display:flex;gap:8px;margin:12px 0}
 button{font:600 13px system-ui;padding:9px 16px;border-radius:8px;border:0;cursor:pointer}
 .lg{background:#1f883d;color:#fff} .rj{background:#2c2c32;color:#f85149} .st{font-size:12px;color:#9a9a96}.err{color:#f85149}
</style>
<div class=wrap>
 <h1 id=title>AppFolio runner</h1>
 <p class=sub>Runs each step automatically. The final Send/Save is LIVE.</p>
 <img id=shot src="/shot?t=0">
 <ol id=steps></ol>
 <div class=bar><button class=lg id=lg style="display:none">Log in to AppFolio</button><button class=rj id=rj>Stop</button></div>
 <div class=st id=st></div>
</div>
<script>
async function tick(){
 let s; try{ s=await (await fetch('/state')).json(); }catch{ return; }
 document.getElementById('title').textContent='AppFolio runner — '+s.flowName+' flow'+(s.workspace?' · '+s.workspace:'');
 document.getElementById('steps').innerHTML=(s.steps||[]).map((st,i)=>{
  let cls='pend',d=i+1;
  if(i<s.idx){cls='done';d='✓';}else if(st.gate){cls='gate';d='!';}else if(i===s.idx){cls='cur';}
  return '<li class='+cls+'><span class=dot>'+d+'</span><span class=nm>'+st.name+'</span></li>';
 }).join('');
 const lg=document.getElementById('lg');
 lg.style.display=(s.status==='needs_login'||s.status==='error')?'inline-block':'none';
 const msg={idle:'No active run.',starting:'Starting…',ready:'Ready.',paused:'Continuing…',running:'Running…',gated:'Stopped before a gated step.',done:'Done — sent/saved via AppFolio.',needs_login:'Logged out — click "Log in to AppFolio".',logging_in:'Signing in…',verifying_2fa:'Reading the texted 2FA code and signing in…',awaiting_2fa:'A window opened — the code should auto-fill, else type it there.',error:'Error: '+s.error}[s.status]||s.status;
 document.getElementById('st').innerHTML='<span class="'+(s.status==='error'?'err':'')+'">'+msg+'</span>';
 document.getElementById('shot').src='/shot?t='+s.shotTs;
}
document.getElementById('lg').onclick=async()=>{await fetch('/login',{method:'POST'});};
document.getElementById('rj').onclick=async()=>{await fetch('/reject',{method:'POST'});};
setInterval(tick,1000);tick();
</script>`;

http
	.createServer(async (req, res) => {
		const u = new URL(req.url, `http://localhost:${PORT}`);
		res.setHeader('access-control-allow-origin', '*');

		if (u.pathname === '/') {
			// Start a new run if query params describe one we're not already running.
			if (u.searchParams.get('flow')) {
				const params = Object.fromEntries(u.searchParams.entries());
				const nextSig = JSON.stringify(params);
				// Don't clobber a run that's still in flight (a second request for the
				// same workspace waits its turn). Cross-workspace never reaches here —
				// each workspace has its own runner process/port.
				const active = !['idle', 'done', 'error'].includes(status);
				if (nextSig !== sig && !busy && !active) {
					sig = nextSig;
					startRun(params).catch((e) => { error = e.message; status = 'error'; });
				}
			}
			res.writeHead(200, { 'content-type': 'text/html' });
			return res.end(SHELL);
		}
		if (u.pathname === '/state') {
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(
				JSON.stringify({ flowName, steps, idx, status, error, shotTs, workspace: curWs?.slug ?? null })
			);
		}
		if (u.pathname === '/stream') {
			res.writeHead(200, {
				'content-type': 'multipart/x-mixed-replace; boundary=frame',
				'cache-control': 'no-store',
				connection: 'close'
			});
			streamClients.add(res);
			if (lastFrame) writeFrame(res, lastFrame);
			req.on('close', () => streamClients.delete(res));
			ensureScreencast().catch((err) => console.error('screencast:', err.message));
			return;
		}
		if (u.pathname.startsWith('/shot')) {
			const file = path.join(HERE, 'run-current.png');
			if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
			res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
			return res.end(fs.readFileSync(file));
		}
		if (u.pathname === '/login' && req.method === 'POST') {
			// Manual retry — fire-and-forget; the panel polls /state for progress.
			loginAttempts = 0;
			startLogin().catch((e) => { error = e.message; status = 'error'; });
			res.writeHead(200); return res.end('ok');
		}
		if (u.pathname === '/reject' && req.method === 'POST') {
			if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
			releaseLoginLock(); // abort during login → free the slot for the other workspace
			status = 'idle'; sig = null; autoRun = false;
			res.writeHead(200); return res.end('ok');
		}
		res.writeHead(404); res.end();
	})
	.listen(PORT, '127.0.0.1', () => {
		console.log(`\nStep runner ready: http://localhost:${PORT} — workspace ${RUNNER_WS_ID}`);
		console.log('Pinned to one account. Idle until a run is requested. Logged-out → auto-login.\n');
	});

// ── Session keepalive ───────────────────────────────────────────────────────
// Every KEEPALIVE_MS, touch an authenticated page so AppFolio's idle timeout
// never fires. Keeping the session warm is what lets us skip 2FA most of the
// time — we only re-login when the session truly dies (e.g. an absolute lifetime
// cap), which is rare. Runs only when idle; yields the page to any real run.
async function keepAliveTick() {
	if (keepAliveBusy || busy || status !== 'idle') return;
	keepAliveBusy = true;
	try {
		const ws = await getWorkspace();
		await ensurePage(HEADED);
		if (busy || status !== 'idle') return; // a run slipped in while launching
		await page.goto(`${ws.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
		if (await looksLoggedOut(page)) {
			console.log(`[keepalive] ${ws.slug}: logged out — will auto-login on next send`);
		} else {
			await context.storageState({ path: ws.stateFile }).catch(() => {}); // persist refreshed cookies
			console.log(`[keepalive] ${ws.slug}: session warm`);
		}
	} catch (e) {
		console.error('keepalive:', e.message);
	} finally {
		keepAliveBusy = false;
	}
}
if (KEEPALIVE_MS) setInterval(() => { keepAliveTick(); }, KEEPALIVE_MS);
