#!/usr/bin/env node
// Main server entrypoint. Wires together the iMessage helper dylib, the
// drafts UI, and the two triggers (chat-poller for inbound iMessages,
// issue-poller for new work orders in Supabase). Skill / tool / orchestrator
// logic lives elsewhere — this file is pure boot orchestration.
//
// Setup prerequisites are documented in imessage/README.md. Run:
//   agent/imessage/run-messages.sh    # in one terminal
//   node agent/server.mjs             # in another

import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helper } from './imessage/helper.mjs';
import { startUi, dispatchDraft } from './ui/index.mjs';
import { startChatPoller } from './triggers/chat-poller.mjs';
import { startIssuePoller } from './triggers/issue-poller.mjs';
import { buildChatGuidIndex, appfolioRunnerTargets } from './core/workspaces.mjs';
import * as db from './state/helpers.mjs';

const HELPER_ENABLED = process.env.HELPER_DISABLED !== '1';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function log(msg) {
	console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`); // local HH:MM:SS (matches the Mac mini's wall clock)
}

function bundleId(appPath) {
	try {
		const r = spawnSync(
			'/usr/libexec/PlistBuddy',
			['-c', 'Print CFBundleIdentifier', path.join(appPath, 'Contents', 'Info.plist')],
			{ encoding: 'utf8' }
		);
		return (r.stdout || '').trim();
	} catch {
		return '';
	}
}

// Open the installed "Bedrock" Chrome PWA on boot so desktop notifications start
// flowing without a manual launch (the notification poller lives in the page, so
// the window must be running to alert on new work orders). We deliberately prefer
// a Chrome PWA (Blink → crisp) and SKIP Safari web apps (com.apple.Safari.WebApp,
// WebKit → fuzzy on this non-Retina display) so a stray "Add to Dock" install is
// never reopened. `open` is single-instance — a restart just focuses it. Set
// WORK_ORDERS_DESKTOP=0 to disable.
function openDesktopApp(port) {
	if (process.env.WORK_ORDERS_DESKTOP === '0') return;
	const home = process.env.HOME || '';
	const dirs = [path.join(home, 'Applications', 'Chrome Apps.localized'), path.join(home, 'Applications')];
	const candidates = [];
	for (const dir of dirs) {
		try {
			for (const n of readdirSync(dir)) {
				if (/bedrock/i.test(n) && n.endsWith('.app')) candidates.push(path.join(dir, n));
			}
		} catch {}
	}
	const appPath =
		candidates.find((p) => bundleId(p).startsWith('com.google.Chrome.app.')) ||
		candidates.find((p) => !bundleId(p).startsWith('com.apple.Safari.WebApp.'));
	if (!appPath) {
		log(
			`Bedrock (Chrome) app not installed — open http://127.0.0.1:${port} in Google Chrome → ⋮ → Cast, Save, and Share → Install page as app. (Not Safari's Add to Dock — WebKit renders fuzzy on this display.)`
		);
		return;
	}
	const child = spawn('open', ['-a', appPath], { stdio: 'ignore', detached: true });
	child.on('error', (e) => log(`desktop app failed to open: ${e.message}`));
	child.unref();
	log(`desktop app opening (${path.basename(appPath)})`);
}

const DESKTOP_DRAFT_WATCH_MS = Number(process.env.DESKTOP_DRAFT_WATCH_MS ?? 1000);
const desktopFocusedDraftIds = new Set();

function focusDesktopForDraft(draft, port, reason) {
	if (!draft?.id || desktopFocusedDraftIds.has(draft.id)) return;
	desktopFocusedDraftIds.add(draft.id);
	openDesktopApp(port);
	log(
		`desktop app focused for new work order (${reason}): ` +
			`issue=${draft.issue_id ?? '(none)'} draft=${draft.id} workspace=${draft.workspace_label ?? '(unknown)'}`
	);
}

// Bring the desktop app forward whenever a PM texts in a mapped group chat —
// same intent as a new work order, just driven off the incoming message rather
// than a draft. The page-side chat-log poller then follows the window to the
// message's workspace. Throttled so a rapid burst is one front-bring, not N
// (mirrors how the burst settles into a single turn). `open` is single-instance,
// so this just focuses the existing window.
const DESKTOP_MESSAGE_FOCUS_THROTTLE_MS = Number(process.env.DESKTOP_MESSAGE_FOCUS_THROTTLE_MS ?? 1500);
let lastDesktopMessageFocusAt = 0;

function focusDesktopForMessage(msg, port) {
	const now = Date.now();
	if (now - lastDesktopMessageFocusAt < DESKTOP_MESSAGE_FOCUS_THROTTLE_MS) return;
	lastDesktopMessageFocusAt = now;
	openDesktopApp(port);
	log(
		`desktop app focused for PM message: ` +
			`workspace=${msg?.workspace_label ?? '(unknown)'} from=${msg?.handle ?? '(unknown)'}`
	);
}

function startDesktopDraftWatcher({ port }) {
	let running = false;
	let bootstrapped = false;
	const timer = setInterval(async () => {
		if (running) return;
		running = true;
		try {
			const drafts = (await db.loadDrafts()).filter((d) => d.trigger === 'new_issue' && d.issue_id);
			if (!bootstrapped) {
				for (const d of drafts) desktopFocusedDraftIds.add(d.id);
				bootstrapped = true;
				return;
			}
			for (const d of drafts) focusDesktopForDraft(d, port, 'draft watcher');
		} catch (err) {
			log(`desktop draft watcher failed: ${err.message}`);
		} finally {
			running = false;
		}
	}, DESKTOP_DRAFT_WATCH_MS);
	return { stop: () => clearInterval(timer) };
}

// ── Env ────────────────────────────────────────────────────────────────────────

async function loadDotEnv(p) {
	try {
		const raw = await fs.readFile(p, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith('#')) continue;
			const i = t.indexOf('=');
			if (i <= 0) continue;
			const k = t.slice(0, i).trim();
			let v = t.slice(i + 1).trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
				v = v.slice(1, -1);
			if (!(k in process.env)) process.env[k] = v;
		}
	} catch {
		/* optional */
	}
}

await loadDotEnv(path.join(SCRIPT_DIR, '..', '.env'));
await loadDotEnv(path.join(SCRIPT_DIR, '.env'));

if (!process.env.OPENAI_API_KEY) {
	console.log('OPENAI_API_KEY not set — checked .env in repo root and agent/');
	process.exit(1);
}

// ── iMessage helper supervision ──────────────────────────────────────────────
// Messages.app (with the injected dylib) is the agent's only mouth — it sends,
// marks read, and shows typing. When it's gone the agent is silently mute, so a
// stray ⌘-Q on the host takes the whole product down. These helpers launch it
// and keep it up.

// Keep Messages.app up. The discriminator that makes this loop-proof is the
// *process*, not the socket: we relaunch only when no Messages process is
// running. A socket drop while Messages is still alive is a transient flap (the
// dylib re-handshakes during boot) and we ignore it — otherwise every flap would
// trigger a relaunch, run-messages.sh would pkill the healthy instance, and that
// kill would generate the next flap: an infinite spawn loop.
//
// run-messages.sh pkills every Messages instance, then `exec`s into one fresh
// instance with the dylib injected. Combined with launching only when none is
// running, that guarantees exactly one instance — no duplicates fighting over
// the socket.
//
// Set HELPER_WATCHDOG_DISABLED=1 to opt out (e.g. a dev worktree that must not
// fight prod over the singleton Messages.app).
const HELPER_WATCHDOG_MS = Number(process.env.HELPER_WATCHDOG_MS ?? 4000);
// Never relaunch more than once per this window — a hard floor against any
// tight loop, even if Messages crashes on boot.
const RELAUNCH_MIN_INTERVAL_MS = Number(process.env.RELAUNCH_MIN_INTERVAL_MS ?? 5000);

let booting = false; // launched but not yet confirmed connected
let lastLaunchAt = 0;

// Is a Messages.app process alive right now? (pgrep -x matches the exact name.)
function messagesRunning() {
	return new Promise((resolve) => {
		execFile('pgrep', ['-x', 'Messages'], (err, stdout) => {
			resolve(!err && stdout.trim().length > 0);
		});
	});
}

function launchMessages(reason) {
	if (booting) return; // a launch is already coming up
	if (Date.now() - lastLaunchAt < RELAUNCH_MIN_INTERVAL_MS) return; // throttle
	booting = true;
	lastLaunchAt = Date.now();
	if (reason) log(`${reason} — launching Messages.app with dylib injected`);
	const script = path.join(SCRIPT_DIR, 'imessage', 'run-messages.sh');
	const proc = spawn(script, [], { stdio: 'ignore' });
	proc.on('error', (err) => log(`Messages.app spawn error: ${err.message}`));
	proc.on('exit', (code, sig) => {
		// If the launcher exited and the dylib never dialed in, the boot failed —
		// clear the flag so the watchdog retries (throttled). If it connected,
		// onConnect already cleared `booting`.
		if (!helper.isConnected()) booting = false;
		if (code && code !== 0) log(`Messages.app exited (code=${code}, sig=${sig})`);
	});
}

function startHelperWatchdog() {
	if (process.env.HELPER_WATCHDOG_DISABLED === '1') {
		log('helper watchdog disabled (HELPER_WATCHDOG_DISABLED=1)');
		return;
	}
	// A real connect means the boot finished: clear `booting` so the next quit
	// can relaunch.
	helper.onConnect(() => {
		booting = false;
	});
	// Fast path: the moment the socket drops, reopen — but ONLY if Messages is
	// actually gone (a real ⌘-Q / crash). A flap while the process lives is
	// transient; ignoring it is what stops the spawn loop.
	helper.onDisconnect(async () => {
		if (await messagesRunning()) return;
		launchMessages('Messages.app quit');
	});
	// Backstop poll. Handles the no-event cases and a wedged dylib (process up
	// but never connects). We require the helper to be down across two polls
	// before replacing a running-but-silent instance, to ride out boot flaps.
	let downPolls = 0;
	const timer = setInterval(async () => {
		if (booting || helper.isConnected()) {
			downPolls = 0;
			return;
		}
		if (!(await messagesRunning())) {
			downPolls = 0;
			launchMessages('Messages.app not running');
			return;
		}
		if (++downPolls >= 2) {
			downPolls = 0;
			launchMessages('helper unresponsive — replacing instance');
		}
	}, HELPER_WATCHDOG_MS);
	timer.unref?.();
	return { stop: () => clearInterval(timer) };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
	// Build the chat-guid index from env. Used by chat-poller to route mapped
	// groupchat rows to chat-log + incoming_user_message event (vs. 1:1 incoming_anon_message).
	const chatGuidIndex = buildChatGuidIndex();
	for (const [guid, w] of chatGuidIndex.entries()) {
		log(`listening on ${w.label}: ${guid} (pm: ${[...w.pm_handles].join(', ') || '(none)'})`);
	}

	if (HELPER_ENABLED) {
		// Register the watchdog FIRST so its onConnect hook is listening before we
		// launch — otherwise the boot-time connect wouldn't clear `booting` and the
		// first ⌘-Q would be swallowed. It keeps Messages.app alive for the life of
		// the process: if the operator ⌘-Q's it (or it crashes), the helper socket
		// drops and the watchdog relaunches it until it dials back in.
		startHelperWatchdog();

		// Launch Messages.app with the helper dylib injected so it dials back
		// into our IPC listener. Skip if the dylib is already connected — e.g.
		// you ran run-messages.sh by hand in another terminal.
		if (!helper.isConnected()) {
			launchMessages('boot');
		}

		// Wait up to ~10s for the helper to dial in. Messages.app needs to
		// quit + relaunch when run-messages.sh fires, which takes a moment.
		for (let i = 0; i < 40 && !helper.isConnected(); i++) {
			await new Promise((r) => setTimeout(r, 250));
		}
		const ping = await helper.ping();
		if (ping.ok) log(`helper online (Messages.app pid=${ping.pid})`);
		else log(`helper offline: ${ping.error} — running without typing/read`);
	} else {
		log('helper disabled via HELPER_DISABLED=1');
	}

	// One send path, shared by the UI Send button and the scheduled auto-fire
	// loop below. Both route through the same dylib call so logs match.
	const sendIMessage = async ({ chatGuid, body }) => {
		// Dev/worktree test hook: when the real helper isn't reachable (e.g. another
		// instance holds the helper port), FAKE_SEND=1 records the send as a success
		// without touching Messages.app. Never set in prod.
		if (process.env.FAKE_SEND === '1') {
			log(`[FAKE_SEND] ${chatGuid}: "${body.slice(0, 60)}${body.length > 60 ? '…' : ''}"`);
			return { ok: true, guid: 'fake_' + Date.now().toString(36) };
		}
		if (!HELPER_ENABLED) {
			return { ok: false, error: 'helper disabled (HELPER_DISABLED=1)' };
		}
		if (!chatGuid) {
			return { ok: false, error: 'draft has no chat guid' };
		}
		const r = await helper.send(chatGuid, body);
		if (!r.ok) {
			log(`work-order send failed: ${r.error}`);
			return { ok: false, error: r.error };
		}
		log(`work-order sent to ${chatGuid}: "${body.slice(0, 60)}${body.length > 60 ? '…' : ''}"`);
		return { ok: true, guid: r.guid ?? null };
	};

	// Drafts UI. Send button calls the dylib via helper.send.
	const uiPort = Number(process.env.WORK_ORDERS_PORT ?? 7878);
	await startUi({
		port: uiPort,
		log,
		sendIMessage
	});

	// Pop the desktop app window now the UI is listening.
	openDesktopApp(uiPort);
	startDesktopDraftWatcher({ port: uiPort });

	// chat-poller: chat.db → incoming_user_message (mapped groupchats) or incoming_anon_message (1:1).
	// onUserMessage fires per incoming PM message in a mapped group chat → surface the desktop app.
	await startChatPoller({
		helper,
		chatGuidIndex,
		log,
		onUserMessage: (msg) => focusDesktopForMessage(msg, uiPort)
	});

	// issue-poller: issues_v2 → new_issue events → drafts.
	await startIssuePoller({
		onDraftCreated: ({ draft, issue, workspace }) => {
			focusDesktopForDraft(
				{ ...draft, issue_id: issue.id, workspace_label: workspace.label },
				uiPort,
				'issue poller'
			);
		}
	});

	// scheduled sender: fires "Send later" drafts when their hold elapses.
	startScheduledSender({ sendIMessage });

	// appfolio runners: one Playwright service PER workspace, each on its own port
	// (own browser + login held in isolation). The drafts UI routes per workspace.
	startAppfolioRunners();

	log('agent server started');
}

// Auto-fire loop for scheduled ("Send later") drafts. Every tick it sweeps the
// drafts file for any that the human approved (approved_at set) whose hold has
// elapsed (hold_until <= now) and dispatches them through the same path as the
// UI Send button. Because drafts are durable JSON, a draft approved overnight
// fires after a restart too — the sweep just catches it once it's overdue.
//
// Invariant: this only ever fires drafts with approved_at set. Approval always
// precedes a send; nothing leaves un-tapped.
const SCHEDULED_POLL_MS = Number(process.env.SCHEDULED_POLL_MS ?? 30000);

function startScheduledSender({ sendIMessage }) {
	let running = false;
	const timer = setInterval(async () => {
		if (running) return;
		running = true;
		try {
			const now = Date.now();
			const drafts = await db.loadDrafts();
			const due = drafts.filter(
				(d) => d.approved_at && d.hold_until && new Date(d.hold_until).getTime() <= now
			);
			for (const draft of due) {
				const raw = draft.messages ?? (draft.body ? [{ body: draft.body }] : []);
				const finals = raw.map((m) => ({ body: String(m?.body ?? '').trim() }));
				const originals = (draft.original_messages ?? finals).map((m) => ({
					body: String(m?.body ?? '').trim()
				}));
				const result = await dispatchDraft({
					draft,
					finals,
					originals,
					edited: false,
					action: 'send',
					forcedSend: false,
					sendIMessage,
					log
				});
				if (result.ok) {
					log(`scheduled send fired: draft=${draft.id} issue=${draft.issue_id} parts=${result.count}`);
				} else {
					log(`scheduled send failed: draft=${draft.id} ${result.error}`);
				}
			}
		} catch (err) {
			log(`scheduled sender error: ${err.message}`);
		} finally {
			running = false;
		}
	}, SCHEDULED_POLL_MS);
	return { stop: () => clearInterval(timer) };
}

// AppFolio step runners. A Playwright-backed HTTP service (appfolio/runner.mjs)
// drives AppFolio and streams the browser to the drafts UI's "Send via AppFolio"
// panel. We run ONE runner process PER AppFolio workspace, each pinned (via
// RUNNER_WORKSPACE_ID + RUNNER_PORT) to a single account with its own browser +
// login. That process boundary is the cross-account safety guarantee: a runner
// physically cannot act in another workspace's AppFolio. Each runs as an
// isolated CHILD PROCESS (own top-level await + browser) so a missing
// Playwright/Chromium or a crashed browser can't take down the agent. Set
// APPFOLIO_RUNNER_DISABLED=1 to skip them all.
const APPFOLIO_RUNNER_ENABLED = process.env.APPFOLIO_RUNNER_DISABLED !== '1';
const APPFOLIO_RUNNER_MAX_RESTARTS = 3;

function startAppfolioRunners() {
	if (!APPFOLIO_RUNNER_ENABLED) {
		log('appfolio runners disabled (APPFOLIO_RUNNER_DISABLED=1)');
		return;
	}
	const script = path.join(SCRIPT_DIR, 'appfolio', 'runner.mjs');
	const targets = appfolioRunnerTargets();
	if (!targets.length) {
		log('no AppFolio workspaces configured — no runners spawned');
		return;
	}
	const kills = [];

	for (const t of targets) {
		let child = null;
		let restarts = 0;

		const spawnOne = () => {
			// Inherit our dotenv (Supabase creds + APPFOLIO_PW_*), pinning this child
			// to one workspace + port. Same process group → Ctrl-C hits every runner.
			child = spawn(process.execPath, [script], {
				cwd: SCRIPT_DIR,
				env: { ...process.env, RUNNER_WORKSPACE_ID: t.workspace_id, RUNNER_PORT: String(t.port) }
			});
			const pipe = (stream) => {
				stream.setEncoding('utf8');
				stream.on('data', (chunk) => {
					for (const line of chunk.split('\n')) if (line.trim()) log(`[appfolio:${t.label}] ${line.trim()}`);
				});
			};
			pipe(child.stdout);
			pipe(child.stderr);
			child.on('error', (err) => log(`appfolio runner(${t.label}) spawn error: ${err.message}`));
			child.on('exit', (code, signal) => {
				if (signal) return; // killed on shutdown — don't restart
				log(`appfolio runner(${t.label}) exited (code=${code})`);
				if (code !== 0 && restarts < APPFOLIO_RUNNER_MAX_RESTARTS) {
					restarts++;
					log(`restarting appfolio runner(${t.label}) (${restarts}/${APPFOLIO_RUNNER_MAX_RESTARTS})…`);
					setTimeout(spawnOne, 2000);
				} else if (code !== 0) {
					log(
						`appfolio runner(${t.label}) keeps failing — likely Playwright is not installed ` +
							'(cd agent && npm i, then npx playwright install chromium). ' +
							'Set APPFOLIO_RUNNER_DISABLED=1 to silence.'
					);
				}
			});
		};

		spawnOne();
		log(`appfolio runner(${t.label}) → :${t.port} (${t.vhost})`);
		kills.push(() => { try { child?.kill(); } catch { /* already gone */ } });
	}

	const killAll = () => kills.forEach((k) => k());
	process.on('exit', killAll);
	process.on('SIGINT', () => { killAll(); process.exit(0); });
	process.on('SIGTERM', () => { killAll(); process.exit(0); });
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
