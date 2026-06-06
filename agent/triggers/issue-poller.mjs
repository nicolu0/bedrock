// Trigger: new row in issues_v2 → route workspace/chat → hand off to the
// dedicated new-work-order intake module.
//
// Workspace-driven routing. The poller fetches issues across all mapped
// workspaces (see WORKSPACES). Each issue's workspace_id resolves to a
// display label (test/prod) AND a recipient chat env var. An issue from a
// workspace not in the table is skipped — we don't know where to send it.
//
// The poller does not run the main agent loop. It polls, routes, dedups, and
// calls processNewWorkOrder(), which owns enrichment, memory, drafting, queueing,
// work-hours holds, and turn traces.
//
// Cursor + dedup state lives in state/issues-cursor.json:
//   { lastCheckedAt: ISO, processedIds: { [issueId]: unixMs } }

import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import * as db from '../state/helpers.mjs';
import { WORKSPACES } from '../core/workspaces.mjs';
import { supabaseEnv } from '../core/supabase.mjs';
import { processNewWorkOrder } from './new-work-order-message.mjs';

const POLL_INTERVAL_MS = 5000;
const MAX_PROCESSED_IDS = 1000;
// On a fresh/cleared cursor, seed the baseline this far in the past instead of
// "now". A WO that lands between shutdown and the next start is older than
// "now", so a now-baseline drops it forever (created_at < lastCheckedAt). Kept
// short so clearing the cursor still avoids replaying old backlog; the
// processedIds dedup absorbs anything already drafted inside the window.
const STARTUP_LOOKBACK_MS = 15 * 60 * 1000; // 15 min
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
	const ts = new Date().toTimeString().slice(0, 8); // local HH:MM:SS (matches the Mac mini's wall clock)
	if (extra) console.log(`[${ts}] [poller] ${msg}`, extra);
	else console.log(`[${ts}] [poller] ${msg}`);
}

// ── Supabase ────────────────────────────────────────────────────────────────

async function fetchNewIssues(cursor) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,workspace_id,appfolio_srn,urgent,created_at',
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

// ── Poll loop ───────────────────────────────────────────────────────────────

async function saveCursor(cursor) {
	const entries = Object.entries(cursor.processedIds).sort((a, b) => b[1] - a[1]);
	cursor.processedIds = Object.fromEntries(entries.slice(0, MAX_PROCESSED_IDS));
	await db.saveCursor('issues', cursor);
}

async function pollOnce({ onDraftCreated } = {}) {
	const cursor = await db.loadCursor('issues');
	cursor.processedIds = cursor.processedIds ?? {};

	const issues = await fetchNewIssues(cursor);
	if (!issues.length) return;

	for (const issue of issues) {
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
			const result = await processNewWorkOrder({
				issue_id: issue.id,
				workspace_id: issue.workspace_id,
				workspace: ws,
				chatGuid,
				participants: resolveParticipants(chatGuid)
			});
			if (!result.ok) {
				log(`new work order intake failed: ${JSON.stringify(result.failure)}`, { id: issue.id });
				continue;
			}
			const { draft, issue: processedIssue } = result;
			log('draft created', {
				draft_id: draft.id,
				workspace: ws.label,
				message_count: draft.messages?.length ?? 0,
				hold_until: draft.hold_until ?? null,
				urgent: !!processedIssue.urgent,
				urgency_reason: processedIssue.urgency_reason ?? null
			});
			if (onDraftCreated) {
				Promise.resolve(onDraftCreated({ draft, issue: processedIssue, workspace: ws })).catch(
					(err) => {
						log(`draft-created hook failed for ${draft.id}: ${err.message}`);
					}
				);
			}
		} catch (err) {
			log(`error processing ${issue.id}: ${err.message}`);
		}
	}
}

export async function startIssuePoller({ onDraftCreated } = {}) {
	const cursor = await db.loadCursor('issues');
	if (!cursor.lastCheckedAt) {
		cursor.lastCheckedAt = new Date(Date.now() - STARTUP_LOOKBACK_MS).toISOString();
		cursor.processedIds = {};
		await db.saveCursor('issues', cursor);
	}

	const mapped = Object.entries(WORKSPACES).map(([id, w]) => {
		const guid = process.env[w.chatEnv];
		const participants = guid ? resolveParticipants(guid) : [];
		return `${w.label}: ${id} → ${w.chatEnv}=${guid ?? '(unset)'} [${participants.join(', ')}]`;
	});
	log(`started (interval=${POLL_INTERVAL_MS}ms, from=${cursor.lastCheckedAt})`);
	for (const line of mapped) log(`  workspace ${line}`);

	let running = false;
	const timer = setInterval(async () => {
		if (running) return;
		running = true;
		try {
			await pollOnce({ onDraftCreated });
		} catch (err) {
			// Node's `fetch failed` hides the real reason in err.cause. Surface it.
			const cause = err?.cause
				? ` (${err.cause.code || err.cause.errno || ''} ${err.cause.message || err.cause})`.trim()
				: '';
			log(`poll error: ${err.message}${cause}`);
		} finally {
			running = false;
		}
	}, POLL_INTERVAL_MS);

	return { stop: () => clearInterval(timer) };
}
