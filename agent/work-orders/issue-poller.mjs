// F1 trigger: new row in issues_v2 -> hand to orchestrator -> bundle draft.
//
// Workspace-driven routing. The poller fetches issues across all mapped
// workspaces (see WORKSPACES below). Each issue's workspace_id resolves to a
// display label (test/prod) AND a recipient chat env var. An issue from a
// workspace not in the table is skipped — we don't know where to send it.
//
// The poller itself does not call the LLM. It hands the issue to the
// orchestrator with trigger='new_issue'; the work-orders orchestrator (with
// its own prompt + tools) runs the turn and returns the send_text bundle.
// The poller then writes one draft row carrying messages: [{ body }, ...].
//
// Cursor + dedup state lives in state/issues-cursor.json:
//   { lastCheckedAt: ISO, processedIds: { [issueId]: unixMs } }
//
// Readiness gate: both agent_runs(intake) and agent_runs(vendor) must be
// 'done' before we draft. Cursor pauses on not-ready issues — never skips.

import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import * as db from './state/helpers.mjs';
import { runTurn } from '../core/orchestrator.mjs';
import { WORKSPACES } from './workspaces.mjs';

const POLL_INTERVAL_MS = 5000;
const MAX_PROCESSED_IDS = 1000;
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

// chat.db handle (readonly) for resolving recipient handles from a chat GUID.
let chatDb = null;
function getChatDb() {
	if (!chatDb) chatDb = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
	return chatDb;
}

function resolveParticipants(chatGuid) {
	if (!chatGuid) return [];
	try {
		const rows = getChatDb()
			.prepare(
				`SELECT h.id
				 FROM chat c
				 JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
				 JOIN handle h ON h.ROWID = chj.handle_id
				 WHERE c.guid = ?`
			)
			.all(chatGuid);
		return rows.map((r) => r.id).filter(Boolean);
	} catch (err) {
		log(`participants lookup failed for ${chatGuid}: ${err.message}`);
		return [];
	}
}

function log(msg, extra) {
	const ts = new Date().toISOString().slice(11, 19);
	if (extra) console.log(`[${ts}] [poller] ${msg}`, extra);
	else console.log(`[${ts}] [poller] ${msg}`);
}

// ── Supabase ────────────────────────────────────────────────────────────────

function supabaseEnv() {
	const url = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
	return { url, key };
}

async function fetchNewIssues(cursor) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select:
			'id,workspace_id,appfolio_srn,name,description,urgent,created_at,property_id,vendor_id,' +
			'tenant:tenants!tenant_id(name),' +
			'property:properties!property_id(name),' +
			'unit:units!unit_id(name),' +
			'vendor:vendors!vendor_id(name),' +
			'agent_runs(agent_name,status)',
		order: 'created_at.asc',
		limit: '20'
	});
	const workspaceIds = Object.keys(WORKSPACES);
	if (workspaceIds.length === 1) {
		params.set('workspace_id', `eq.${workspaceIds[0]}`);
	} else {
		params.set('workspace_id', `in.(${workspaceIds.join(',')})`);
	}
	if (cursor.lastCheckedAt) params.set('created_at', `gte.${cursor.lastCheckedAt}`);

	const res = await fetch(`${url}/rest/v1/issues_v2?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
	return res.json();
}

function isReady(issue) {
	const runs = issue.agent_runs ?? [];
	const intake = runs.find((r) => r.agent_name === 'intake');
	const vendor = runs.find((r) => r.agent_name === 'vendor');
	return intake?.status === 'done' && vendor?.status === 'done';
}

// ── Weekend hold ────────────────────────────────────────────────────────────

function weekendHold(now = new Date()) {
	const day = now.getDay(); // 0 Sun, 6 Sat
	if (day !== 0 && day !== 6) return null;
	const monday = new Date(now);
	const daysUntilMonday = (8 - day) % 7 || 1;
	monday.setDate(monday.getDate() + daysUntilMonday);
	monday.setHours(9, 0, 0, 0);
	return monday.toISOString();
}

// ── Poll loop ───────────────────────────────────────────────────────────────

async function saveCursor(cursor) {
	const entries = Object.entries(cursor.processedIds).sort((a, b) => b[1] - a[1]);
	cursor.processedIds = Object.fromEntries(entries.slice(0, MAX_PROCESSED_IDS));
	await db.saveCursor('issues', cursor);
}

async function pollOnce({ requireReady }) {
	const cursor = await db.loadCursor('issues');
	cursor.processedIds = cursor.processedIds ?? {};

	const issues = await fetchNewIssues(cursor);
	if (!issues.length) return;

	for (const issue of issues) {
		if (requireReady && !isReady(issue)) {
			log('issue not ready, waiting on intake/vendor', {
				id: issue.id,
				workspace: issue.workspace_id
			});
			break; // pause cursor — re-poll next tick
		}

		const ws = WORKSPACES[issue.workspace_id];
		if (!ws) {
			log('unknown workspace, skipping', { id: issue.id, workspace: issue.workspace_id });
			cursor.processedIds[issue.id] = Date.now();
			if (!cursor.lastCheckedAt || issue.created_at > cursor.lastCheckedAt) {
				cursor.lastCheckedAt = issue.created_at;
			}
			await saveCursor(cursor);
			continue;
		}

		const chatGuid = process.env[ws.chatEnv] ?? null;
		if (!chatGuid) {
			log(`no ${ws.chatEnv} set for workspace=${ws.label}, skipping`, { id: issue.id });
			cursor.processedIds[issue.id] = Date.now();
			if (!cursor.lastCheckedAt || issue.created_at > cursor.lastCheckedAt) {
				cursor.lastCheckedAt = issue.created_at;
			}
			await saveCursor(cursor);
			continue;
		}

		if (!cursor.lastCheckedAt || issue.created_at > cursor.lastCheckedAt) {
			cursor.lastCheckedAt = issue.created_at;
		}
		if (cursor.processedIds[issue.id]) continue;

		// Mark before generating so a crash mid-draft doesn't double-fire.
		cursor.processedIds[issue.id] = Date.now();
		await saveCursor(cursor);

		log('new work order', {
			id: issue.id,
			workspace: ws.label,
			srn: issue.appfolio_srn,
			urgent: !!issue.urgent
		});

		try {
			const ctx = { workspace_label: ws.label, chat_guid: chatGuid };
			const { messages } = await runTurn({
				trigger: 'new_issue',
				ctx,
				input: { issue }
			});

			if (!messages?.length) {
				log('empty message bundle, skipping draft', { id: issue.id });
				continue;
			}

			const hold = issue.urgent ? null : weekendHold();
			const draft = await db.createDraft({
				trigger: 'new_issue',
				channel: 'groupchat',
				workspace_id: issue.workspace_id,
				workspace_label: ws.label,
				issue_id: issue.id,
				to: chatGuid,
				to_participants: resolveParticipants(chatGuid),
				messages,
				hold_until: hold
			});
			log('draft created', {
				draft_id: draft.id,
				workspace: ws.label,
				message_count: messages.length,
				hold_until: hold
			});
		} catch (err) {
			log(`error processing ${issue.id}: ${err.message}`);
		}
	}
}

export async function startIssuePoller() {
	const requireReady = process.env.WORK_ORDERS_REQUIRE_READY !== '0';

	const cursor = await db.loadCursor('issues');
	if (!cursor.lastCheckedAt) {
		cursor.lastCheckedAt = new Date().toISOString();
		cursor.processedIds = {};
		await db.saveCursor('issues', cursor);
	}

	const mapped = Object.entries(WORKSPACES).map(([id, w]) => {
		const guid = process.env[w.chatEnv];
		const participants = guid ? resolveParticipants(guid) : [];
		return `${w.label}: ${id} → ${w.chatEnv}=${guid ?? '(unset)'} [${participants.join(', ')}]`;
	});
	log(
		`started (interval=${POLL_INTERVAL_MS}ms, require_ready=${requireReady}, from=${cursor.lastCheckedAt})`
	);
	for (const line of mapped) log(`  workspace ${line}`);

	let running = false;
	const timer = setInterval(async () => {
		if (running) return;
		running = true;
		try {
			await pollOnce({ requireReady });
		} catch (err) {
			log(`poll error: ${err.message}`);
		} finally {
			running = false;
		}
	}, POLL_INTERVAL_MS);

	return { stop: () => clearInterval(timer) };
}
