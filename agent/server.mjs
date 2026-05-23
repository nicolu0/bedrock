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
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helper } from './imessage/helper.mjs';
import { startUi } from './ui/index.mjs';
import { startChatPoller } from './triggers/chat-poller.mjs';
import { startIssuePoller } from './triggers/issue-poller.mjs';
import { buildChatGuidIndex } from './core/workspaces.mjs';

const HELPER_ENABLED = process.env.HELPER_DISABLED !== '1';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function log(msg) {
	console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
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

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
	// Build the chat-guid index from env. Used by chat-poller to route mapped
	// groupchat rows to chat-log + pm_reply event (vs. 1:1 demo_message).
	const chatGuidIndex = buildChatGuidIndex();
	for (const [guid, w] of chatGuidIndex.entries()) {
		log(`listening on ${w.label}: ${guid} (pm: ${[...w.pm_handles].join(', ') || '(none)'})`);
	}

	if (HELPER_ENABLED) {
		// Launch Messages.app with the helper dylib injected so it dials back
		// into our IPC listener. Skip if the dylib is already connected — e.g.
		// you ran run-messages.sh by hand in another terminal.
		if (!helper.isConnected()) {
			const script = path.join(SCRIPT_DIR, 'imessage', 'run-messages.sh');
			log('launching Messages.app with helper dylib injected');
			const proc = spawn(script, [], { stdio: 'ignore' });
			proc.on('error', (err) => log(`Messages.app spawn error: ${err.message}`));
			proc.on('exit', (code, sig) => {
				if (code !== 0) log(`Messages.app exited (code=${code}, sig=${sig})`);
			});
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

	// Drafts UI. Send button calls the dylib via helper.send.
	await startUi({
		port: Number(process.env.WORK_ORDERS_PORT ?? 7878),
		log,
		sendIMessage: async ({ chatGuid, body }) => {
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
			log(
				`work-order sent to ${chatGuid}: "${body.slice(0, 60)}${body.length > 60 ? '…' : ''}"`
			);
			return { ok: true, guid: r.guid ?? null };
		}
	});

	// chat-poller: chat.db → pm_reply (mapped groupchats) or demo_message (1:1).
	await startChatPoller({ helper, chatGuidIndex, log });

	// issue-poller: issues_v2 → new_issue events → drafts.
	await startIssuePoller();

	log('agent server started');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
