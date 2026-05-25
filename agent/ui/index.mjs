// Drafts UI http server. One module, started from agent/server.mjs.
//
// Routes:
//   GET  /                        -> page.html
//   GET  /api/drafts              -> array of pending drafts (bundles)
//   POST /api/drafts/:id/send     -> send each message in order via dylib, log, remove draft
//   POST /api/drafts/:id/copy     -> log response (copy), remove draft
//   POST /api/drafts/:id/dismiss  -> log response (dismiss), remove draft
//   GET  /kpi                     -> rolled-up KPI numbers from the logs
//
// Each draft is a bundle: { id, messages: [{ body }, ...], ... }. Send replays
// the bundle in order, calling the injected sendIMessage callback per message
// with a small gap so they arrive as distinct iMessage bubbles.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from '../state/helpers.mjs';
import { WORKSPACES, normalizeHandle } from '../core/workspaces.mjs';
import { deleteIssuesByWorkspace, supabaseEnv } from '../core/supabase.mjs';
import * as memory from '../core/memory.mjs';
import { getDb as getChatDb, extractText, appleDateToISO } from '../triggers/chat-poller.mjs';

// Cofounder phone numbers that act as the agent post-pivot. The chat_messages
// table stores is_from_me as the raw chat.db value (true only for messages
// sent from this Mac mini). For UI rendering and downstream LLM prompts we
// want "agent" to include the cofounders' personas too — this helper does
// that overlay using WORKSPACES.agent_handles. The DB row is unchanged.
function isAgentHandleForWorkspace(workspace_id, handle) {
	if (!handle) return false;
	return (WORKSPACES[workspace_id]?.agent_handles ?? []).includes(handle);
}

// ── chat_sessions / chat_messages REST helpers (read-only) ────────────────

async function listChatSessions(workspace_id) {
	const { url, key } = supabaseEnv();
	// Nested select via PostgREST: sessions with their chat_messages embedded.
	// Saves the N+1 per-session-transcript round trip the UI used to do.
	const params = new URLSearchParams({
		select:
			'id,chat_guid,started_at,ended_at,message_count,participants,issue_ids,entities,tags,summary,observations_extracted_at,messages:chat_messages(id,workspace_id,ts,is_from_me,handle,body,issue_id,source_rowid)',
		workspace_id: `eq.${workspace_id}`,
		order: 'started_at.desc',
		'messages.order': 'ts.asc'
	});
	const res = await fetch(`${url}/rest/v1/chat_sessions?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`listChatSessions: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	// Apply the is_agent overlay (raw is_from_me OR a configured agent_handle)
	// to every embedded message so the UI doesn't need to know workspace config.
	return rows.map((s) => ({
		...s,
		messages: (s.messages ?? []).map((m) => ({
			...m,
			is_agent: m.is_from_me || isAgentHandleForWorkspace(m.workspace_id, m.handle)
		}))
	}));
}

// ── entities REST helpers (read-only) ─────────────────────────────────────

async function listEntitiesForWorkspace(workspace_id) {
	const { url, key } = supabaseEnv();
	// Pull entities with their belief and observation reference counts in one
	// PostgREST query via embedded count selectors.
	const params = new URLSearchParams({
		select:
			'id,kind,name,ref_table,ref_id,metadata,created_at,updated_at,belief_count:belief_entities(count),observation_count:observation_entities(count)',
		workspace_id: `eq.${workspace_id}`,
		order: 'kind.asc,name.asc'
	});
	const res = await fetch(`${url}/rest/v1/entities?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`listEntitiesForWorkspace: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	// PostgREST returns counts as [{ count: N }] — flatten.
	return rows.map((r) => ({
		...r,
		belief_count: Array.isArray(r.belief_count) ? r.belief_count[0]?.count ?? 0 : 0,
		observation_count: Array.isArray(r.observation_count) ? r.observation_count[0]?.count ?? 0 : 0
	}));
}

async function listBeliefEntityEdges(workspace_id) {
	const { url, key } = supabaseEnv();
	// Scope edges to this workspace by joining through beliefs.
	const params = new URLSearchParams({
		select: 'belief_id,entity_id,belief:beliefs!inner(workspace_id)',
		'belief.workspace_id': `eq.${workspace_id}`
	});
	const res = await fetch(`${url}/rest/v1/belief_entities?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`listBeliefEntityEdges: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows.map((r) => ({ belief_id: r.belief_id, entity_id: r.entity_id }));
}

async function listObservationEntityEdges(workspace_id) {
	const { url, key } = supabaseEnv();
	// Scope edges via the observation's workspace_id.
	const params = new URLSearchParams({
		select: 'observation_id,entity_id,weight,observation:observations!inner(workspace_id)',
		'observation.workspace_id': `eq.${workspace_id}`
	});
	const res = await fetch(`${url}/rest/v1/observation_entities?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`listObservationEntityEdges: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows.map((r) => ({
		observation_id: r.observation_id,
		entity_id: r.entity_id,
		weight: r.weight ?? 1.0
	}));
}

// Property↔owner structural edges. Derived from the legacy `owner_properties`
// join table by mapping legacy property/owner row IDs to their entity rows
// (via entity.ref_id). Returned as [{ property_entity_id, owner_entity_id }].
async function listStructuralEdges(workspace_id) {
	const { url, key } = supabaseEnv();
	const eRes = await fetch(
		`${url}/rest/v1/entities?select=id,kind,ref_id&workspace_id=eq.${workspace_id}&kind=in.(property,owner)&ref_id=not.is.null`,
		{ headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } }
	);
	if (!eRes.ok) throw new Error(`listStructuralEdges(entities): ${eRes.status} ${await eRes.text()}`);
	const entities = await eRes.json();
	const propByRef = new Map();
	const ownerByRef = new Map();
	for (const e of entities) {
		if (e.kind === 'property') propByRef.set(e.ref_id, e.id);
		else if (e.kind === 'owner') ownerByRef.set(e.ref_id, e.id);
	}

	const opRes = await fetch(
		`${url}/rest/v1/owner_properties?select=property_id,owner_id&workspace_id=eq.${workspace_id}`,
		{ headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } }
	);
	if (!opRes.ok) throw new Error(`listStructuralEdges(owner_properties): ${opRes.status} ${await opRes.text()}`);
	const ops = await opRes.json();

	const edges = [];
	for (const op of ops) {
		const pId = propByRef.get(op.property_id);
		const oId = ownerByRef.get(op.owner_id);
		if (pId && oId) edges.push({ property_entity_id: pId, owner_entity_id: oId });
	}
	return edges;
}

async function listBeliefsForEntity(entity_id) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select:
			'belief:beliefs(id,claim,scope,confidence,explicitness,created_by,created_at,updated_at,tags)',
		entity_id: `eq.${entity_id}`
	});
	const res = await fetch(`${url}/rest/v1/belief_entities?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`listBeliefsForEntity: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows.map((r) => r.belief).filter(Boolean);
}

async function deleteChatSession(session_id) {
	const { url, key } = supabaseEnv();
	const h = { apikey: key, Authorization: `Bearer ${key}` };
	// Drop messages first. chat_messages.session_id is ON DELETE SET NULL, so
	// not strictly required for FK, but we want a full purge — orphaned rows
	// would never be re-sessionized (UNIQUE constraint blocks re-insert) and
	// would just take up space.
	const mres = await fetch(
		`${url}/rest/v1/chat_messages?session_id=eq.${session_id}`,
		{ method: 'DELETE', headers: h }
	);
	if (!mres.ok) throw new Error(`deleteChatSession(messages): ${mres.status} ${await mres.text()}`);
	const sres = await fetch(`${url}/rest/v1/chat_sessions?id=eq.${session_id}`, {
		method: 'DELETE',
		headers: h
	});
	if (!sres.ok) throw new Error(`deleteChatSession(session): ${sres.status} ${await sres.text()}`);
}

async function listChatMessagesForSession(session_id) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,workspace_id,ts,is_from_me,handle,body,issue_id,source_rowid',
		session_id: `eq.${session_id}`,
		order: 'ts.asc'
	});
	const res = await fetch(`${url}/rest/v1/chat_messages?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok)
		throw new Error(`listChatMessagesForSession: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	// Overlay: is_agent is the effective sender role (raw is_from_me OR a
	// configured agent_handle). UI uses this for me/them bubble alignment.
	return rows.map((m) => ({
		...m,
		is_agent: m.is_from_me || isAgentHandleForWorkspace(m.workspace_id, m.handle)
	}));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.join(__dirname, 'page.html');
const STATE_DIR = process.env.BEDROCK_STATE_DIR || path.join(__dirname, '..', 'state');
const TURNS_LOG_PATH = path.join(STATE_DIR, 'turns.jsonl');

const SEND_GAP_MS = 700; // delay between consecutive bubbles in a bundle

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function diffText(a, b) {
	if (a === b) return null;
	return `--- original\n${a}\n--- final\n${b}`;
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return {};
	}
}

function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(body)
	});
	res.end(body);
}

function text(res, status, value) {
	res.writeHead(status, { 'content-type': 'text/plain' });
	res.end(value);
}

// Map ?workspace=prod|test (or a raw workspace_id) to a workspace uuid via
// WORKSPACES. Memory endpoints reject 'all' — the graph is workspace-scoped
// by design.
function resolveWorkspaceId(value) {
	if (!value || value === 'all') return null;
	// If it already looks like a uuid, accept it.
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
		return value;
	}
	for (const [id, w] of Object.entries(WORKSPACES)) {
		if (w.label === value) return id;
	}
	return null;
}

function normalizeMessages(input, fallback) {
	if (Array.isArray(input)) return input.map((m) => ({ body: String(m?.body ?? '').trim() }));
	if (Array.isArray(fallback)) return fallback.map((m) => ({ body: String(m?.body ?? '').trim() }));
	return [];
}

export async function startUi({ port = 7878, host = '127.0.0.1', sendIMessage, log = console.log } = {}) {
	// Verify the page file exists at boot but read it on every request so edits
	// to page.html show up on browser refresh without a server restart.
	await fs.access(PAGE_PATH);

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const { pathname } = url;

		try {
			if (req.method === 'GET' && pathname === '/') {
				const pageHtml = await fs.readFile(PAGE_PATH, 'utf8');
				res.writeHead(200, {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store'
				});
				res.end(pageHtml);
				return;
			}

			if (req.method === 'GET' && pathname === '/api/drafts') {
				const drafts = await db.loadDrafts();
				// One-time backfill: older drafts created before original_messages
				// existed get it set from their current body, so future edits show
				// up as edits (against the backfilled baseline, which is the best
				// approximation we have for what the agent originally produced).
				for (const d of drafts) {
					if (Array.isArray(d.messages) && !Array.isArray(d.original_messages)) {
						await db.updateDraft(d.id, {
							original_messages: d.messages.map((m) => ({ body: m.body }))
						});
						d.original_messages = d.messages.map((m) => ({ body: m.body }));
					}
				}
				return json(res, 200, drafts);
			}

			const updateMatch = pathname.match(/^\/api\/drafts\/([^/]+)$/);
			if ((req.method === 'PATCH' || req.method === 'PUT') && updateMatch) {
				const [, id] = updateMatch;
				const payload = await readBody(req);
				if (!Array.isArray(payload.messages)) {
					return text(res, 400, 'messages array required');
				}
				const messages = normalizeMessages(payload.messages);
				const updated = await db.updateDraft(id, { messages });
				if (!updated) return text(res, 404, 'draft not found');
				return json(res, 200, { ok: true });
			}

			const historyPatchMatch = pathname.match(/^\/api\/history\/([^/]+)$/);
			if (req.method === 'PATCH' && historyPatchMatch) {
				const [, draftId] = historyPatchMatch;
				const payload = await readBody(req);
				if (typeof payload.notes !== 'string' && payload.notes !== null) {
					return text(res, 400, 'notes (string or null) required');
				}
				const updated = await db.updateResponse(draftId, {
					notes: payload.notes ?? '',
					notes_updated_at: new Date().toISOString()
				});
				if (!updated) return text(res, 404, 'response not found');
				return json(res, 200, { ok: true });
			}

			// ── Memory graph endpoints ───────────────────────────────────────
			// All workspace-scoped. ?workspace=prod|test resolves via WORKSPACES.

			if (req.method === 'GET' && pathname === '/api/memory/graph') {
				const workspace_id = resolveWorkspaceId(url.searchParams.get('workspace'));
				if (!workspace_id) return text(res, 400, 'workspace=prod|test required');
				const [
					observations,
					beliefs,
					edges,
					entities,
					entity_edges,
					structural_edges,
					observation_entity_edges
				] = await Promise.all([
					memory.listObservations(workspace_id, { limit: 500 }),
					memory.listBeliefs(workspace_id, { limit: 500 }),
					memory.listEdges(workspace_id),
					listEntitiesForWorkspace(workspace_id),
					listBeliefEntityEdges(workspace_id),
					listStructuralEdges(workspace_id),
					listObservationEntityEdges(workspace_id)
				]);
				return json(res, 200, {
					observations,
					beliefs,
					edges,
					entities,
					entity_edges,
					structural_edges,
					observation_entity_edges
				});
			}

			if (req.method === 'GET' && pathname === '/api/memory/search') {
				const workspace_id = resolveWorkspaceId(url.searchParams.get('workspace'));
				if (!workspace_id) return text(res, 400, 'workspace=prod|test required');
				const q = (url.searchParams.get('q') ?? '').trim();
				if (!q) return json(res, 200, { observations: [], beliefs: [] });
				const [obsAll, beliefsAll] = await Promise.all([
					memory.listObservations(workspace_id, { limit: 500 }),
					memory.listBeliefs(workspace_id, { limit: 500 })
				]);
				const needle = q.toLowerCase();
				const matchesObs = (o) =>
					(o.summary ?? '').toLowerCase().includes(needle) ||
					(o.raw_text ?? '').toLowerCase().includes(needle) ||
					(o.tags ?? []).some((t) => t.toLowerCase().includes(needle));
				const matchesBel = (b) =>
					(b.claim ?? '').toLowerCase().includes(needle) ||
					JSON.stringify(b.scope ?? {}).toLowerCase().includes(needle) ||
					(b.tags ?? []).some((t) => t.toLowerCase().includes(needle));
				return json(res, 200, {
					observations: obsAll.filter(matchesObs).map((o) => o.id),
					beliefs: beliefsAll.filter(matchesBel).map((b) => b.id)
				});
			}

			if (req.method === 'POST' && pathname === '/api/memory/beliefs') {
				const workspace_id = resolveWorkspaceId(url.searchParams.get('workspace'));
				if (!workspace_id) return text(res, 400, 'workspace=prod|test required');
				const payload = await readBody(req);
				if (!payload.claim) return text(res, 400, 'claim required');
				try {
					const belief = await memory.createBelief(workspace_id, {
						claim: payload.claim,
						scope: payload.scope ?? {},
						confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.85,
						explicitness: payload.explicitness ?? 'stated',
						created_by: 'user',
						tags: payload.tags ?? []
					});
					return json(res, 200, belief);
				} catch (err) {
					return text(res, 500, err.message);
				}
			}

			const beliefPatchMatch = pathname.match(/^\/api\/memory\/beliefs\/([^/]+)$/);
			if (req.method === 'PATCH' && beliefPatchMatch) {
				const [, id] = beliefPatchMatch;
				const payload = await readBody(req);
				try {
					const belief = await memory.updateBelief(id, payload);
					return json(res, 200, belief);
				} catch (err) {
					return text(res, 500, err.message);
				}
			}

			if (req.method === 'DELETE' && beliefPatchMatch) {
				const [, id] = beliefPatchMatch;
				try {
					await memory.deleteBelief(id);
					return json(res, 200, { ok: true });
				} catch (err) {
					return text(res, 500, err.message);
				}
			}

			// ── Chat sessions endpoints ──────────────────────────────────────
			// Read-only views over chat_sessions + chat_messages. The Sessions
			// tab uses these to render the persisted iMessage transcript broken
			// into conversational sessions.

			if (req.method === 'GET' && pathname === '/api/sessions') {
				const workspace_id = resolveWorkspaceId(url.searchParams.get('workspace'));
				if (!workspace_id) return text(res, 400, 'workspace=prod|test required');
				const sessions = await listChatSessions(workspace_id);
				return json(res, 200, sessions);
			}

			const sessionMsgsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
			if (req.method === 'GET' && sessionMsgsMatch) {
				const [, session_id] = sessionMsgsMatch;
				const messages = await listChatMessagesForSession(session_id);
				return json(res, 200, messages);
			}

			const sessionItemMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
			if (req.method === 'DELETE' && sessionItemMatch) {
				const [, session_id] = sessionItemMatch;
				await deleteChatSession(session_id);
				return json(res, 200, { ok: true });
			}

			// ── Entities endpoints ───────────────────────────────────────────

			if (req.method === 'GET' && pathname === '/api/entities') {
				const workspace_id = resolveWorkspaceId(url.searchParams.get('workspace'));
				if (!workspace_id) return text(res, 400, 'workspace=prod|test required');
				const rows = await listEntitiesForWorkspace(workspace_id);
				return json(res, 200, rows);
			}

			const entityBeliefsMatch = pathname.match(/^\/api\/entities\/([^/]+)\/beliefs$/);
			if (req.method === 'GET' && entityBeliefsMatch) {
				const [, entity_id] = entityBeliefsMatch;
				const beliefs = await listBeliefsForEntity(entity_id);
				return json(res, 200, beliefs);
			}

			if (req.method === 'POST' && pathname === '/api/clear-test') {
				const testEntry = Object.entries(WORKSPACES).find(([, w]) => w.label === 'test');
				if (!testEntry) return text(res, 500, 'no test workspace configured');
				const [test_ws_id] = testEntry;
				const local = await db.clearWorkspaceLocalState('test');
				const supa = await deleteIssuesByWorkspace(test_ws_id);
				log(`cleared test workspace: ${JSON.stringify({ local, supa })}`);
				return json(res, 200, { ok: true, local, supabase: supa });
			}

			if (req.method === 'GET' && pathname === '/api/chat-log') {
				const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
				const ws = url.searchParams.get('workspace'); // optional filter
				const all = await db.loadChatMessages();
				let items = all;
				if (ws) items = items.filter((m) => m.workspace_label === ws);
				items = items.slice(-limit).reverse();
				return json(res, 200, items);
			}

			// Orchestrator turn log. One JSONL row per runTurn (see
			// core/orchestrator.mjs appendTurnLog). Read the whole file, slice
			// last-N, newest-first. Rows predating the identity enrichment lack
			// workspace_label and so are dropped by the ?workspace filter.
			if (req.method === 'GET' && pathname === '/api/turns') {
				const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 200));
				const ws = url.searchParams.get('workspace'); // optional filter
				const raw = await fs.readFile(TURNS_LOG_PATH, 'utf8').catch(() => '');
				let items = raw
					.split('\n')
					.filter(Boolean)
					.map((line) => {
						try {
							return JSON.parse(line);
						} catch {
							return null;
						}
					})
					.filter(Boolean);
				if (ws) items = items.filter((t) => t.workspace_label === ws);
				items = items.slice(-limit).reverse();
				return json(res, 200, items);
			}

			if (req.method === 'GET' && pathname === '/api/chat-thread') {
				const wsLabel = url.searchParams.get('workspace') ?? 'prod';
				const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 500));
				const entry = Object.entries(WORKSPACES).find(([, w]) => w.label === wsLabel);
				if (!entry) return json(res, 200, { messages: [], pm_handles: [], agent_handles: [], pm_label: 'jose' });
				const [, w] = entry;
				const chat_guid = process.env[w.chatEnv];
				const pm_label = w.pm_label ?? 'jose';
				if (!chat_guid) return json(res, 200, { messages: [], pm_handles: [], agent_handles: [], pm_label });
				const pmSet = new Set((w.pm_handles ?? []).map(normalizeHandle));
				const agentSet = new Set((w.agent_handles ?? []).map(normalizeHandle));
				try {
					const rows = getChatDb()
						.prepare(
							`SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, m.is_from_me,
							        h.id AS handle
							 FROM message m
							 LEFT JOIN handle h ON h.ROWID = m.handle_id
							 LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
							 LEFT JOIN chat c ON c.ROWID = cmj.chat_id
							 WHERE c.guid = ?
							   AND m.service = 'iMessage'
							   AND COALESCE(m.cache_has_attachments, 0) = 0
							 ORDER BY m.date DESC
							 LIMIT ?`
						)
						.all(chat_guid, limit);
					const messages = rows
						.map((r) => {
							const text = extractText(r);
							if (!text) return null;
							const handle = normalizeHandle(r.handle);
							const isFromMe = Number(r.is_from_me) === 1;
							// is_from_me always wins. In 1:1 (style=45) chats chat.db
							// stores the OTHER party's handle on outbound rows, which
							// previously made my own messages match pmSet and land
							// on the left.
							const isPm = !isFromMe && !!handle && pmSet.has(handle);
							const side = isPm ? 'left' : 'right';
							return {
								guid: r.guid,
								ts: appleDateToISO(r.date),
								handle: handle || null,
								is_from_me: isFromMe,
								text,
								side
							};
						})
						.filter(Boolean)
						.reverse();
					return json(res, 200, {
						messages,
						pm_handles: [...pmSet],
						agent_handles: [...agentSet],
						pm_label
					});
				} catch (err) {
					return json(res, 500, { error: err.message });
				}
			}

			if (req.method === 'GET' && pathname === '/api/history') {
				const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
				const [responses, sent] = await Promise.all([db.loadResponses(), db.loadSent()]);
				const sentByBundle = new Map();
				for (const s of sent) {
					if (!s.bundle_id) continue;
					const arr = sentByBundle.get(s.bundle_id) ?? [];
					arr.push(s);
					sentByBundle.set(s.bundle_id, arr);
				}
				const items = responses
					.slice(-limit)
					.reverse()
					.map((r) => ({ ...r, sent_messages: sentByBundle.get(r.draft_id) ?? [] }));
				return json(res, 200, items);
			}

			if (req.method === 'GET' && pathname === '/kpi') {
				const [allSent, allResponses] = await Promise.all([db.loadSent(), db.loadResponses()]);
				// KPIs are prod-only. Test traffic is dev/QA noise and would
				// inflate or skew the real send-without-edit numbers.
				const sent = allSent.filter((r) => r.workspace_label === 'prod');
				const responses = allResponses.filter((r) => r.workspace_label === 'prod');
				const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
				const recent = responses.filter((r) => new Date(r.timestamp).getTime() >= since);
				const sends = recent.filter((r) => r.action === 'send');
				const cleanSends = sends.filter((r) => !r.edited);
				const byChannel = {};
				for (const r of recent) {
					const c = (byChannel[r.channel] ??= { send: 0, copy: 0, dismiss: 0, edited: 0 });
					c[r.action] = (c[r.action] ?? 0) + 1;
					if (r.edited) c.edited++;
				}
				return json(res, 200, {
					window_days: 30,
					scope: 'prod',
					sent_total: sent.length,
					responses_total: responses.length,
					recent_responses: recent.length,
					send_without_edit_rate: sends.length ? cleanSends.length / sends.length : null,
					by_channel: byChannel
				});
			}

			const actionMatch = pathname.match(/^\/api\/drafts\/([^/]+)\/(send|copy|dismiss)$/);
			if (req.method === 'POST' && actionMatch) {
				const [, id, action] = actionMatch;
				const payload = await readBody(req);

				const drafts = await db.loadDrafts();
				const draft = drafts.find((d) => d.id === id);
				if (!draft) return text(res, 404, 'draft not found');

				const draftMessages = draft.messages ?? (draft.body ? [{ body: draft.body }] : []);
				const draftOriginals = draft.original_messages ?? draftMessages;
				const finals = normalizeMessages(payload.messages, draftMessages);
				const originals = normalizeMessages(draftOriginals, draftMessages);
				// Pad to the same length so we can index pairwise.
				while (originals.length < finals.length) originals.push({ body: '' });
				while (finals.length < originals.length) finals.push({ body: '' });

				const editedFlags = finals.map((m, i) => m.body !== originals[i].body);
				const anyEdited = editedFlags.some(Boolean);

				if (action === 'send') {
					if (!finals.length) return text(res, 400, 'no messages to send');
					if (!sendIMessage) return text(res, 500, 'sendIMessage not configured');
					const sentEntries = [];
					for (let i = 0; i < finals.length; i++) {
						const body = finals[i].body;
						if (!body) continue;
						const result = await sendIMessage({ chatGuid: draft.to, body, draft });
						if (!result?.ok) {
							// Persist what we got so far; surface error.
							for (const e of sentEntries) await db.appendSent(e);
							return text(res, 500, `send failed at message ${i + 1}: ${result?.error ?? 'unknown'}`);
						}
						sentEntries.push({
							message_guid: result.guid ?? null,
							bundle_id: draft.id,
							part_index: i,
							issue_id: draft.issue_id,
							channel: draft.channel,
							workspace_id: draft.workspace_id ?? null,
							workspace_label: draft.workspace_label ?? null,
							// For groupchat sends, draft.to is the chat GUID. F2's chat
							// skill filters recent sends by this to keep candidates
							// scoped to the chat the PM is replying in.
							chat_guid: draft.channel === 'groupchat' ? draft.to ?? null : null,
							body
						});
						if (i < finals.length - 1) await sleep(SEND_GAP_MS);
					}
					for (const e of sentEntries) await db.appendSent(e);
				}

				await db.appendResponse({
					draft_id: draft.id,
					issue_id: draft.issue_id,
					channel: draft.channel,
					trigger: draft.trigger,
					workspace_id: draft.workspace_id ?? null,
					workspace_label: draft.workspace_label ?? null,
					to: draft.to ?? null,
					to_participants: draft.to_participants ?? [],
					action,
					messages_original: originals.map((m) => m.body),
					messages_final: finals.map((m) => m.body),
					edited: anyEdited,
					diffs: finals.map((m, i) => diffText(originals[i].body, m.body)),
					forced_send: action === 'send' && draft.hold_until ? true : false
				});

				await db.removeDraft(id);
				return json(res, 200, { ok: true, count: finals.length });
			}

			text(res, 404, 'not found');
		} catch (err) {
			log(`ui error: ${err.stack ?? err.message}`);
			text(res, 500, err.message);
		}
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			server.off('error', reject);
			resolve();
		});
	});

	log(`drafts UI listening on http://${host}:${port}`);
	return { server, close: () => new Promise((r) => server.close(r)) };
}
