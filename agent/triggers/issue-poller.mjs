// Trigger: new row in issues_v2 → emit a new_issue event → orchestrator routes
// to process_work_order skill → bundle draft.
//
// Workspace-driven routing. The poller fetches issues across all mapped
// workspaces (see WORKSPACES). Each issue's workspace_id resolves to a
// display label (test/prod) AND a recipient chat env var. An issue from a
// workspace not in the table is skipped — we don't know where to send it.
//
// The poller sets the issue up deterministically before the agent sees it: it
// enriches the row (AppFolio unit + clean description + a mini-LLM title) and
// fetches the workspace vendor roster, then emits a normalized AgentEvent with
// the enriched issue + candidate vendors as payload. The orchestrator handles
// only the decisions — read_memory, set_vendor, send_text — via the
// process_work_order skill. The poller then writes one draft row carrying
// messages: [{ body }, ...].
//
// Cursor + dedup state lives in state/issues-cursor.json:
//   { lastCheckedAt: ISO, processedIds: { [issueId]: unixMs } }

import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import * as db from '../state/helpers.mjs';
import { runTurn } from '../core/orchestrator.mjs';
import { enrichIssue } from './enrich-issue.mjs';
import { WORKSPACES } from '../core/workspaces.mjs';
import { supabaseEnv } from '../core/supabase.mjs';
import { nextSendTime } from '../core/work-hours.mjs';

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

async function fetchNewIssues(cursor) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select:
			'id,workspace_id,appfolio_srn,name,description,urgent,created_at,property_id,vendor_id,' +
			'tenant:tenants!tenant_id(name),' +
			'property:properties!property_id(name),' +
			'unit:units!unit_id(name),' +
			'vendor:vendors!vendor_id(name)',
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

// Per-poll cache: don't refetch a workspace's vendor list across multiple
// issues from the same workspace in one tick.
async function fetchWorkspaceVendors(workspace_id, cache) {
	if (cache.has(workspace_id)) return cache.get(workspace_id);
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,name',
		workspace_id: `eq.${workspace_id}`,
		order: 'name.asc'
	});
	const res = await fetch(`${url}/rest/v1/vendors?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) {
		log(`vendor fetch failed for workspace=${workspace_id}: ${res.status}`);
		cache.set(workspace_id, []);
		return [];
	}
	const rows = await res.json();
	cache.set(workspace_id, rows);
	return rows;
}

// ── Poll loop ───────────────────────────────────────────────────────────────

async function saveCursor(cursor) {
	const entries = Object.entries(cursor.processedIds).sort((a, b) => b[1] - a[1]);
	cursor.processedIds = Object.fromEntries(entries.slice(0, MAX_PROCESSED_IDS));
	await db.saveCursor('issues', cursor);
}

async function pollOnce() {
	const cursor = await db.loadCursor('issues');
	cursor.processedIds = cursor.processedIds ?? {};

	const issues = await fetchNewIssues(cursor);
	if (!issues.length) return;

	const vendorCache = new Map();

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
			// Set up the issue before the agent sees it: enrich (unit + clean
			// description + title) and the vendor roster run in parallel — both are
			// just data-gathering. Enrich is best-effort; on failure we fall back to
			// whatever the join already gave us rather than skip the draft.
			const [candidate_vendors, enriched] = await Promise.all([
				fetchWorkspaceVendors(issue.workspace_id, vendorCache),
				enrichIssue(issue.id).catch((err) => {
					log(`enrich failed for ${issue.id}: ${err.message}`);
					return null;
				})
			]);
			if (enriched?.ok) {
				if (enriched.unit) issue.unit = enriched.unit;
				if (enriched.tenant) issue.tenant = enriched.tenant;
				if (enriched.property) issue.property = enriched.property;
				if (enriched.name) issue.name = enriched.name;
				if (enriched.description) issue.description = enriched.description;
				// Urgency is the agent's call now (triaged in enrich), with the PMS
				// flag as one input. It drives the hold below and rides the
				// new_issue payload into the turn log for the Turns tab.
				if (typeof enriched.urgent === 'boolean') issue.urgent = enriched.urgent;
				if (enriched.urgency_reason) issue.urgency_reason = enriched.urgency_reason;
			}

			const event = {
				type: 'new_issue',
				payload: { issue, candidate_vendors }
			};
			const ctx = {
				workspace_id: issue.workspace_id,
				sendMode: 'draft',
				workspace_label: ws.label,
				chat_guid: chatGuid,
				// Skill drafts a message bundle for a groupchat that includes the
				// PM, but the orchestrator never live-sends from this path.
				// Belt-and-suspenders.
				isPmHandle: true
			};
			const result = await runTurn(event, ctx);
			const messages = result.drafts;

			// Failure is a warning, not a hard skip — if the loop produced a
			// usable bundle (drafts present) we still want the human to see
			// it. Only skip when the bundle is empty.
			if (result.failure) {
				log(`new_issue warning: ${JSON.stringify(result.failure)}`, {
					id: issue.id,
					drafts: messages?.length ?? 0
				});
			}
			if (!messages?.length) {
				log('empty message bundle, skipping draft', { id: issue.id });
				continue;
			}

			// Off-hours arrivals get held to the next work-hours open (the
			// "Send later" path). Inside work hours, or agent-judged
				// urgent (see enrich triage), no hold.
			const hold = issue.urgent ? null : nextSendTime();
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
				hold_until: hold,
				urgent: !!issue.urgent,
				urgency_reason: issue.urgency_reason ?? null
			});
		} catch (err) {
			log(`error processing ${issue.id}: ${err.message}`);
		}
	}
}

export async function startIssuePoller() {
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
	log(`started (interval=${POLL_INTERVAL_MS}ms, from=${cursor.lastCheckedAt})`);
	for (const line of mapped) log(`  workspace ${line}`);

	let running = false;
	const timer = setInterval(async () => {
		if (running) return;
		running = true;
		try {
			await pollOnce();
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
