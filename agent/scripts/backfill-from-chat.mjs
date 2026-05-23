#!/usr/bin/env node
// Backfill the chat sessionization + memory graph from ~/Library/Messages/chat.db.
//
// Two phases:
//   Phase 1 — sessionize: walk chat.db for the target chat_guid, group rows
//             into conversationally-continuous sessions, persist chat_messages
//             + chat_sessions to Supabase. Idempotent via a watermark
//             (agent/data/backfill-cursor.json, keyed by chat_guid).
//   Phase 2 — extract:    walk chat_sessions where observations_extracted_at
//             IS NULL, run an LLM over each session's transcript, write
//             observations via memory.addObservation (which fires the
//             belief-former). Idempotent via observations_extracted_at.
//
// Usage:
//   node agent/scripts/backfill-from-chat.mjs --workspace=prod --phase=1 --dry-run
//   node agent/scripts/backfill-from-chat.mjs --workspace=prod --phase=1 --confirm-cost
//   node agent/scripts/backfill-from-chat.mjs --workspace=prod --phase=2 --limit=5 --confirm-cost
//   node agent/scripts/backfill-from-chat.mjs --workspace=prod --confirm-cost  (both phases)
//
// Phase 1: --limit=N stops after N chat.db rows ingested (the watermark advances).
// Phase 2: --limit=N stops after N sessions processed.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(AGENT_ROOT, '..');
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const CURSOR_PATH = path.join(AGENT_ROOT, 'data', 'backfill-cursor.json');

const WORKSPACE_LABELS = {
	prod: '2e4373a0-40b8-42c2-a873-b08c99dbf76a',
	test: '40d675ba-4dec-47dd-9222-79c0345c493f'
};
const WORKSPACE_CHATENV = {
	prod: 'JOSE_CHAT_GUID',
	test: 'TEST_CHAT_GUID'
};

const OBSERVATION_MODEL = process.env.OBSERVATION_EXTRACTOR_MODEL || 'gpt-5.4-2026-03-05';
// Midpoint of $0.05–$0.20 per session — rough estimate for cost gate.
const COST_PER_SESSION_USD = 0.12;
const MAX_MESSAGES_PER_LLM_CALL = 200;
const WATERMARK_FLUSH_EVERY = 100;

// ── env ──────────────────────────────────────────────────────────────────────

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
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
				v = v.slice(1, -1);
			}
			if (!(k in process.env)) process.env[k] = v;
		}
	} catch {
		/* optional */
	}
}

await loadDotEnv(path.join(REPO_ROOT, '.env'));
await loadDotEnv(path.join(AGENT_ROOT, '.env'));

// ── args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name) {
	for (const a of args) {
		if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
		if (a === `--${name}`) return true;
	}
	return null;
}

const wsArg = arg('workspace');
const phaseArg = (arg('phase') || 'all').toString();
const limitArg = arg('limit');
const limit = limitArg ? Number(limitArg) : Infinity;
const dryRun = arg('dry-run') === true;
const confirmCost = arg('confirm-cost') === true;
// --start-ts=ISO — filter chat.db rows to m.date >= this ISO timestamp. Use
// this for the initial backfill to skip pre-pivot conversational noise.
// chat.db ROWIDs are NOT chronological in this chat (iCloud sync allocates
// new rowids for old dates), so a rowid watermark alone won't trim by date.
const startTsArg = arg('start-ts');
const startTsMs = startTsArg ? Date.parse(startTsArg) : null;
if (startTsArg && !Number.isFinite(startTsMs)) {
	console.error(`bad --start-ts: ${startTsArg} (must be ISO 8601, e.g. 2026-04-07T18:57:38Z)`);
	process.exit(2);
}
// chat.db (macOS Ventura+) stores message.date in NANOSECONDS since
// 2001-01-01 UTC. APPLE_EPOCH_MS = 978307200000. Convert ISO → apple ns.
const APPLE_EPOCH_MS = 978307200000;
const startTsAppleNs = startTsMs != null ? (startTsMs - APPLE_EPOCH_MS) * 1e6 : null;

if (!wsArg) {
	usage('--workspace required');
	process.exit(2);
}
if (!['1', 'entities', '2', 'beliefs', 'all'].includes(phaseArg)) {
	usage(`--phase must be 1, entities, 2, beliefs, or all (got: ${phaseArg})`);
	process.exit(2);
}

function usage(msg) {
	console.error(msg);
	console.error(
		'usage: node agent/scripts/backfill-from-chat.mjs --workspace=<prod|test|uuid> [--phase=1|entities|2|beliefs|all] [--limit=N] [--dry-run] [--confirm-cost]'
	);
}

const workspace_id = WORKSPACE_LABELS[wsArg] ?? wsArg;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspace_id)) {
	usage(`bad --workspace: ${wsArg} (not a uuid and not a known label)`);
	process.exit(2);
}

const chatEnvVar = WORKSPACE_CHATENV[wsArg];
const chat_guid = chatEnvVar ? process.env[chatEnvVar] : null;
if (!chat_guid && wsArg in WORKSPACE_CHATENV) {
	console.error(`env ${chatEnvVar} not set (needed to resolve target chat_guid)`);
	process.exit(2);
}
if (!chat_guid) {
	console.error(`don't know which chat_guid to use for workspace=${wsArg}`);
	process.exit(2);
}

// Required env (skipped in --dry-run since we don't talk to Supabase or OpenAI).
if (!dryRun) {
	for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) {
		if (!process.env[k]) {
			console.error(`env ${k} not set; source the repo .env first`);
			process.exit(2);
		}
	}
	if (!process.env.PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) {
		console.error('env PUBLIC_SUPABASE_URL or SUPABASE_URL not set');
		process.exit(2);
	}
}

// Late imports so the env above is loaded first.
const sessionizer = dryRun ? null : await import('../core/sessionizer.mjs');
const memory = dryRun ? null : await import('../core/memory.mjs');
const { supabaseEnv } = dryRun ? { supabaseEnv: null } : await import('../supabase.mjs');
const { runBeliefFormer } = dryRun
	? { runBeliefFormer: null }
	: await import('../core/belief-former.mjs');
const entitiesModule = dryRun ? null : await import('../core/entities.mjs');
const { WORKSPACES } = await import('../core/workspaces.mjs');
const AGENT_HANDLES = new Set(WORKSPACES[workspace_id]?.agent_handles ?? []);
function effectiveSender(is_from_me, handle) {
	if (is_from_me) return 'agent';
	if (handle && AGENT_HANDLES.has(handle)) return 'agent';
	return handle || 'unknown';
}

console.log(
	`backfill: workspace=${wsArg}→${workspace_id} chat_guid=${chat_guid.slice(0, 16)}… phase=${phaseArg} limit=${limit === Infinity ? '∞' : limit} dryRun=${dryRun}`
);

// ── chat.db helpers (copied from agent/server.mjs to keep this script standalone) ──

let _db = null;
function getDb() {
	if (!_db) _db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
	return _db;
}

// macOS Ventura+ stores message text in attributedBody (NSAttributedString
// streamtyped binary). The length-encoding bytes vary unpredictably across
// macOS/iCloud versions, so instead of decoding the typedstream we scan for
// the longest printable UTF-8 run between the "NSString" class marker and
// the next attribute-related class marker (NSDictionary / NSNumber / NSValue
// / __kIM…). That run is the actual string body.
//
// Previous parsers tried to decode Apple's length markers (0x81/0x82/0x84)
// and got tripped up by variants that use little-endian or class-instance
// references instead of inline lengths — visible as a leading "E\x01" plus
// truncation at ~69 chars.
function extractText(row) {
	if (row.text) return row.text;
	const blob = row.attributedBody;
	if (!blob || !Buffer.isBuffer(blob)) return null;

	const stringMarker = Buffer.from('NSString');
	const stringIdx = blob.indexOf(stringMarker);
	if (stringIdx < 0) return null;

	// Boundary: the first attribute-class marker after "NSString". The string
	// body sits between "NSString" and these.
	const endMarkers = ['NSDictionary', 'NSNumber', 'NSValue', '__kIM', '_kIM'];
	let endIdx = blob.length;
	for (const m of endMarkers) {
		const idx = blob.indexOf(Buffer.from(m), stringIdx + stringMarker.length);
		if (idx >= 0 && idx < endIdx) endIdx = idx;
	}

	// Scan for the longest run of bytes that look like a UTF-8 string body —
	// tab, newline, CR, printable ASCII, or UTF-8 multibyte continuation.
	let bestStart = -1;
	let bestLen = 0;
	let curStart = -1;
	let curLen = 0;
	for (let i = stringIdx + stringMarker.length; i < endIdx; i++) {
		const b = blob[i];
		const isPrintable =
			b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) || b >= 0x80;
		if (isPrintable) {
			if (curStart === -1) curStart = i;
			curLen++;
			if (curLen > bestLen) {
				bestLen = curLen;
				bestStart = curStart;
			}
		} else {
			curStart = -1;
			curLen = 0;
		}
	}

	if (bestLen < 2) return null;
	let text = blob.slice(bestStart, bestStart + bestLen).toString('utf8');
	// Apple short-string encoding leaks through the heuristic as "+ [len-byte]
	// [string]" when the length byte happens to be printable ASCII (lengths
	// 32–126). Detect by checking that the byte after '+' equals the remaining
	// text length, and slice the proper N chars.
	if (text.length >= 2 && text.charCodeAt(0) === 0x2b) {
		const lenByte = text.charCodeAt(1);
		if (lenByte >= 1 && lenByte <= 127 && lenByte <= text.length - 2) {
			text = text.slice(2, 2 + lenByte);
		}
	}
	// Strip leading control chars and trailing U+FFFD garbage from invalid
	// UTF-8 bytes that bleed in from attribute metadata.
	text = text
		.replace(/^[\x01-\x1f\x7f]+/, '')
		.replace(/[�\x01-\x1f\x7f]+$/, '')
		.trim();
	return text || null;
}

// macOS message.date is nanoseconds since 2001-01-01 on Sierra+ (the schema
// we care about). Older schemas used seconds; we autodetect on magnitude so
// we don't return a date in year 33,000 if a low-numbered row sneaks through.
// APPLE_EPOCH_MS declared above (used by --start-ts conversion too).
function appleDateToISO(date) {
	const n = Number(date);
	if (!Number.isFinite(n) || n <= 0) return null;
	const ms = n > 1e10 ? APPLE_EPOCH_MS + n / 1e6 : APPLE_EPOCH_MS + n * 1000;
	return new Date(ms).toISOString();
}

function fetchChatRows(afterRowId) {
	// No SQL LIMIT — Apple ROWIDs aren't chronologically monotonic (iCloud
	// sync of historical messages allocates new ROWIDs for old dates), so a
	// rowid-LIMITed slice isn't a chronologically-meaningful window. We pull
	// everything, sort by date in Node, then process. Watermark only advances
	// on a full successful run (no --limit), to avoid skipping rowids we
	// haven't actually processed.
	//
	// --start-ts filter: trim noise before a given timestamp. chat.db stores
	// m.date in nanoseconds since 2001-01-01 UTC; we compute the apple-ns
	// equivalent once at startup and pass it as a SQL bind.
	const startTsClause = startTsAppleNs != null ? 'AND m.date >= ?' : '';
	const sql = `
		SELECT
		  m.ROWID AS rowid,
		  m.guid,
		  m.text,
		  m.attributedBody,
		  m.date,
		  m.is_from_me,
		  m.service,
		  COALESCE(m.cache_has_attachments, 0) AS has_attachments,
		  h.id AS handle,
		  c.guid AS chat_guid,
		  c.style AS chat_style,
		  c.room_name AS room_name
		FROM message m
		LEFT JOIN handle h ON h.ROWID = m.handle_id
		LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
		LEFT JOIN chat c ON c.ROWID = cmj.chat_id
		WHERE m.ROWID > ?
		  AND m.service = 'iMessage'
		  AND COALESCE(m.cache_has_attachments, 0) = 0
		  AND c.guid = ?
		  ${startTsClause}
		ORDER BY m.ROWID ASC
	`;
	const binds =
		startTsAppleNs != null
			? [Number(afterRowId) || 0, chat_guid, startTsAppleNs]
			: [Number(afterRowId) || 0, chat_guid];
	const rows = getDb().prepare(sql).all(...binds);
	return rows.map((r) => ({ ...r, text: extractText(r) }));
}

// ── watermark ────────────────────────────────────────────────────────────────

async function loadCursor() {
	try {
		const raw = await fs.readFile(CURSOR_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

async function saveCursor(cursor) {
	const tmp = `${CURSOR_PATH}.tmp`;
	await fs.mkdir(path.dirname(CURSOR_PATH), { recursive: true });
	await fs.writeFile(tmp, JSON.stringify(cursor, null, 2));
	await fs.rename(tmp, CURSOR_PATH);
}

// ── handle normalization (E.164 / lowercase email) ───────────────────────────

function normalizeHandle(raw) {
	if (!raw) return '';
	const v = String(raw).trim();
	if (!v) return '';
	if (v.includes('@')) return v.toLowerCase();
	const cleaned = v.replace(/[^\d+]/g, '');
	if (cleaned.startsWith('+')) return `+${cleaned.slice(1).replace(/\D/g, '')}`;
	const d = cleaned.replace(/\D/g, '');
	if (d.length === 11 && d.startsWith('1')) return `+${d}`;
	if (d.length === 10) return `+1${d}`;
	if (d.length > 0) return `+${d}`;
	return v.toLowerCase();
}

// ── phase 1: sessionize ──────────────────────────────────────────────────────

async function phase1() {
	const cursor = await loadCursor();
	const startRowId = Number(cursor[chat_guid] ?? 0);
	console.log(`\n[phase 1] watermark for ${chat_guid.slice(0, 16)}… = ROWID ${startRowId}`);

	const rowsByRowid = fetchChatRows(startRowId);
	console.log(`[phase 1] chat.db returned ${rowsByRowid.length} rows after ROWID ${startRowId}`);

	// --limit in phase 1 is preview-only because Apple ROWIDs aren't
	// chronologically monotonic — a partial run by message-count would leave
	// rowid gaps below the watermark, and those messages would be skipped on
	// the next run. Force --dry-run for partial phase-1 runs.
	if (limit !== Infinity && !dryRun) {
		console.error(
			`[phase 1] --limit=${limit} is only allowed with --dry-run (rowid coverage isn't contiguous; partial runs would lose messages).`
		);
		process.exit(2);
	}
	if (rowsByRowid.length === 0) {
		console.log(`[phase 1] nothing to ingest — already at head.`);
		return { ingested: 0, sessionsOpened: 0, finalRowId: startRowId };
	}

	// chat.db ROWIDs are NOT in chronological order — Apple assigns them on
	// insertion (incl. iCloud sync of old messages), which differs from
	// message.date (the send time). The sessionizer needs chronological order
	// for sane boundary calls, so sort by date here. Watermark still advances
	// by max(rowid) since that's the contiguous-fetch axis.
	const rows = rowsByRowid.slice().sort((a, b) => {
		const da = Number(a.date) || 0;
		const db = Number(b.date) || 0;
		return da - db;
	});

	// Cost gate not needed for phase 1 — sessionizer uses gpt-mini for judge +
	// summary and the bulk is mini-only. Estimate well under $1 for thousands
	// of messages. Skip --confirm-cost.

	let ingested = 0;
	let sessionsOpened = 0;
	let maxRowId = startRowId;
	let lastTs = null;
	const judgeOverride = dryRun ? () => 'continue' : null;

	for (const row of rows) {
		if (ingested >= limit) {
			console.log(`[phase 1] hit --limit=${limit}, stopping`);
			break;
		}
		const rowid = Number(row.rowid);
		if (rowid > maxRowId) maxRowId = rowid;

		const text = String(row.text || '').trim();
		if (!text) continue;
		const ts = appleDateToISO(row.date);
		if (!ts) continue;
		const handle = normalizeHandle(row.handle);
		const is_from_me = Number(row.is_from_me) === 1;

		if (dryRun) {
			const gapStr = lastTs
				? ` (+${((new Date(ts).getTime() - new Date(lastTs).getTime()) / 60000).toFixed(0)}m)`
				: '';
			console.log(
				`  [dry] rowid=${row.rowid} ts=${ts}${gapStr} ${effectiveSender(is_from_me, handle).slice(0, 16)}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`
			);
			lastTs = ts;
		} else {
			const result = await sessionizer.ingestMessage(
				{
					workspace_id,
					chat_guid,
					handle,
					is_from_me,
					body: text,
					ts,
					source_rowid: rowid,
					source_guid: row.guid,
					issue_id: null
				},
				{ judgeOverride }
			);
			if (result.opened_new) sessionsOpened++;
		}

		ingested++;

		if (!dryRun && ingested % WATERMARK_FLUSH_EVERY === 0) {
			cursor[chat_guid] = maxRowId;
			await saveCursor(cursor);
			console.log(`  · ingested ${ingested}, watermark=${maxRowId}, sessions opened=${sessionsOpened}`);
		}
	}

	// If we consumed all returned rows without hitting --limit, close the
	// trailing open session so it gets summarized + embedded. If --limit hit,
	// leave it open — next run will continue it.
	if (!dryRun) {
		const reachedEnd = ingested < limit;
		if (reachedEnd) {
			const flushed = await sessionizer.flushOpenSessions();
			console.log(`[phase 1] flushed ${flushed.closed} trailing open session(s)`);
		} else {
			console.log(`[phase 1] --limit hit, leaving trailing session open`);
		}
		cursor[chat_guid] = maxRowId;
		await saveCursor(cursor);
	}

	console.log(
		`[phase 1] done: ingested=${ingested} sessionsOpened=${sessionsOpened} maxRowId=${maxRowId}`
	);
	return { ingested, sessionsOpened, finalRowId: maxRowId };
}

// ── phase 2: extract observations ────────────────────────────────────────────

async function fetchUnprocessedSessions() {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,started_at,ended_at,summary,entities,tags,issue_ids,message_count',
		workspace_id: `eq.${workspace_id}`,
		chat_guid: `eq.${chat_guid}`,
		observations_extracted_at: 'is.null',
		order: 'started_at.asc'
	});
	const res = await fetch(`${url}/rest/v1/chat_sessions?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`fetchUnprocessedSessions: ${res.status} ${await res.text()}`);
	return res.json();
}

async function fetchSessionMessages(session_id) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,ts,is_from_me,handle,body,source_guid',
		session_id: `eq.${session_id}`,
		order: 'ts.asc'
	});
	const res = await fetch(`${url}/rest/v1/chat_messages?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`fetchSessionMessages: ${res.status} ${await res.text()}`);
	return res.json();
}

async function patchSessionExtractedAt(session_id) {
	const { url, key } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/chat_sessions?id=eq.${session_id}`, {
		method: 'PATCH',
		headers: {
			apikey: key,
			Authorization: `Bearer ${key}`,
			'Content-Type': 'application/json',
			Prefer: 'return=minimal'
		},
		body: JSON.stringify({ observations_extracted_at: new Date().toISOString() })
	});
	if (!res.ok) throw new Error(`patchSessionExtractedAt: ${res.status} ${await res.text()}`);
}

const OBS_EXTRACT_SYSTEM = `You read a chat-session transcript between a property manager ("Jose", the PM) and an AI agent (which may be the cofounders Andrew/Nico typing manually) coordinating maintenance work orders. You extract OBSERVATIONS — past-tense, specific events grounded in Jose's responses that TEACH THE AGENT something for future work orders.

# THE VALUE TEST (apply BEFORE emitting any observation)

An observation must be WORTH REMEMBERING — it teaches future routing OR captures a specific event the agent should be able to recall later. If Jose's response is just acknowledgment or generic "I'll handle it" with no named vendor/property/owner and no rule, the agent has nothing to use later — SKIP.

Example SKIP: tenant question forwarded → Jose "I'm on it and will be getting a tree trimmer onsite soon. No need to do anything." → no named vendor, no named property in Jose's reply, no rule, no recallable event. SKIP.

# HARD REQUIREMENT: at least one named entity

Every observation MUST include at least one entity (vendor or property; owner only if owner-specific). If you cannot identify a specific named vendor or property tied to the event, the obs has nothing to anchor to and CANNOT support future retrieval — SKIP.

# What IS an observation

An observation captures a SPECIFIC EVENT triggered by Jose's response — a decision, dispatch, override, refusal, status update, retirement, or stated rule — and PASSES the teachability test above. The signal lives in JOSE'S WORDS. Agent questions/suggestions are the elicitation; Jose's reply is the obs trigger.

Be HIGH-RECALL where teachability is satisfied: weekend-batch sessions often produce 3–5 observations; some produce more. Most agent–Jose exchanges with a named-vendor / named-property decision yield an observation. The downstream belief-former generalizes these — your job is to faithfully capture the events.

# What is NOT an observation

- Agent messages with no Jose reply — NO obs (the chat may extend outside this session; don't fabricate).
- Jose responses that fail the teachability test (generic "I'll handle it" with no entity named).
- Pure scheduling / acknowledgments / likes / "got it" / "thanks" with no decision content.
- Coordination chat about logistics (in-office hours, "I'll be there in 10 min") with no maintenance signal.
- Tenant-only situations with no Jose decision attached.
- **MISSING-CONTEXT RULE (STRICT)**: If Jose names a vendor or makes a directive but you CANNOT find the SPECIFIC ISSUE in the immediately preceding 1–3 agent messages, SKIP. Don't fabricate a generic "X dispatched" obs without an issue. Examples of must-skip:
   - Jose: "I sent it to Abraham" — when no recent agent question describes a specific issue being addressed → SKIP.
   - Jose: "Send it to Yonic since he replaced the shower valve" — when no shower-valve question precedes → SKIP.
   - In general: an obs without a specific issue (or a stated rule) has nothing for the agent to retrieve later.
- When chat context is otherwise unclear, DEFAULT to no obs. Skip rather than fabricate.

# Required fields per observation

- **title**: ≤10 words. Shape: \`subject → outcome\`. Examples: \`Glencoe fire alarm → JL\`, \`Primrose garage → Jose self-handled\`, \`Darwin → retired\`. NO parentheticals. Used as a scannable headline.
- **summary**: 12–18 words, max 20. TELEGRAPHIC, not narrative. Past-tense, subject-verb-object. Drop articles. Drop surnames when first name is clear. Use \`+\` for "and". Use \`over\` / \`declined\` instead of "instead of". Examples:
   ✓ "Kori fixed closet door at 17 Ozone Ave unit 7; Jose overrode Guox suggestion."
   ✓ "Jose self-handled stuck garage door at 6337 Primrose Ave."
   ✗ "Kori Anderson was dispatched and ended up fixing the broken closet door at 17 Ozone Avenue unit 7, after Jose decided to override Andrew's earlier suggestion of using Guox..."
- **source_quote**: VERBATIM Jose response that triggered the obs. Most decisive line. Required (don't infer/synthesize from agent messages).
- **entities**: ARRAY of \`{kind, name, weight}\` objects covering EVERY vendor and property relevant to the event — including REJECTED candidates (the agent suggested Y, Jose picked X — both Y and X go in, with different weights).
   - kind ∈ {"vendor", "property", "owner"}
   - name = string as referenced in the chat (or canonical when obvious); resolveEntity does fuzzy match downstream
   - weight ∈ [-1, 1]: signed strength of the entity's role in this observation:
     • **+1.0** — chosen / dispatched vendor, subject property where event happened, explicit preference rule ("we always use Kori for Harrison")
     • **+0.5** — supporting context ("Kori has worked here before, consider Kori")
     • **0** — neutral mention (rare; usually skip)
     • **−0.5** — alternative not picked, no strong rejection language ("Dever was the closer option, Jose picked Primex")
     • **−1.0** — explicit rejection or exclusion ("don't send Darwin", "we never handle the washing machines here")
   - **DO NOT add owners by default.** Owners are reachable from properties via the legacy join. ONLY include an owner when the obs is OWNER-SPECIFIC: a stated rule about that owner ("Solomon Grauzinis Trust requires approval for all issues"), an owner-approval gate, or the owner is the SUBJECT.
- **tags**: 2–6 normalized labels. Examples: \`vendor-dispatch\`, \`vendor-override\`, \`pm-self-handle\`, \`owner-approval-required\`, \`recurring-treatment\`, \`pm-declined-self-handle\`, \`status-resolved\`, \`vendor-retirement\`, \`tenant-resolved\`, \`escalation-from-self-handle\`, \`pm-tenant-coordination\`, \`vendor-overloaded\`, \`pm-stated-rule\`, \`pm-asked-to-remember\`, \`multi-issue-single-vendor\`, \`tenant-acts-as-manager\`, \`no-dispatch\`. Plus trade tags: \`plumbing\`, \`electrical\`, \`pest\`, \`appliance\`, \`fire-alarm\`, \`fridge\`, \`garage-door\`, \`elevator\`, \`drain\`, \`gates\`, etc. Use \`+\` or include multiple.
- **salience**: 0..1. Stated rule / explicit preference = 0.85–0.95. Routine dispatch = 0.4–0.6. Default 0.5.
- **source_message_id**: source_guid of the Jose message. Optional if unclear; null OK.

# Critical extraction rules

1. **Jose's response is the trigger.** When Jose says nothing about a question, no obs for that question — even if you know the dispatch happened elsewhere. The chat is the source of truth.

2. **JL IS JOSE.** "JL" / "JL Unlimited Services LLC" is Jose's OWN company — when Jose says "assign to JL" or "send it to JL", he IS dispatching HIMSELF. They are the SAME ENTITY and INTERCHANGEABLE. Pick ONE name (prefer "Jose") and don't combine them. NEVER write "Jose assigned JL", "Jose dispatched JL", "Jose self-handled X via JL" — these all redundantly mention the same entity twice. Just write "Jose self-handled X" or equivalently "JL handled X" — pick one.

   This applies ONLY for PHYSICAL WORK. Three Jose-handles-it patterns:
   - **Pattern A (JL dispatch = self-handle)**: Jose commits to physical work — "I'll fix it", "I'll stop by", "assign it to JL", "I'll be there", "I'll take care of it". → **MUST add JL Unlimited Services LLC as a vendor entity with weight +1**, tag \`pm-self-handle\`. This is non-optional: every Pattern A obs needs JL on it. Summary: *"Jose self-handled X at Y"* (preferred) — DO NOT add "via JL" or "by assigning to JL" since Jose=JL already.
   - **Pattern B (owner coordination)**: Jose communicates with the owner — "I'll discuss with the owner", "I'll send to the owners for approval", "I'm coordinating directly". → DO NOT add JL. Tag \`owner-approval-required\` or \`pm-owner-coordination\`.
   - **Pattern C (tenant coordination)**: Jose calls/talks to tenant — "I'll call them to discuss", "I'll talk to them tomorrow". → DO NOT add JL. Tag \`pm-tenant-coordination\` or \`tenant-behavior-suspected\`.

3. **Vendor-without-issue mapping.** If Jose's reply names a vendor without specifying the issue (e.g. "send cross appliance and yonic for disposal"), map each vendor to the issue it was paired with in the agent's preceding question. Split into separate obs per issue.

4. **Keep rejected vendors as entities.** When the agent suggests X and Jose picks Y (override case), put BOTH X and Y in the entities array. Tag \`vendor-override\`. This preserves the negative-preference signal for future retrieval.

5. **Owner cascade.** When you emit a property entity, also emit its known owner(s) when you can derive them from context (or include the property's owner pattern from the chat). If unknown, leave to the downstream cascade.

6. **Multi-issue weekend bundles.** One agent message may pose 3+ separate work-order questions; Jose's reply may answer them concisely. Produce ONE obs per DISTINCT work-order/decision pair, not one mega-obs. Use the same source_quote across all obs derived from the same Jose response.

   BUT: if Jose dispatches ONE vendor for MULTIPLE issues at the SAME property in a single response ("Send both to Abraham" for doorknob + drains at unit 4), emit ONE merged obs listing the issues — NOT separate obs per issue. Same dispatch event = one obs.

6b. **Within-session deduplication.** Before emitting each obs, verify it captures a DISTINCT EVENT from any other obs you're emitting for this session. Two extractions that describe the same underlying decision (e.g. one captures the action, another captures the same action's rationale) should be merged into a single richer obs.

6c. **Vendor declines scope X, accepts scope Y.** When a vendor declines one type of work but accepts another (e.g. "Waadt doesn't do repairs but will quote the replacement") and Jose dispatches them for the accepted scope, the vendor's weight is **+1** (chosen for the work done). The declined scope is contextual, NOT a rejection of the vendor.

7. **Status updates count.** Jose confirming "yes" to "was X fixed?" is an obs (tag \`status-resolved\`). Tenant-side resolution is an obs (tag \`tenant-resolved\`, \`no-dispatch\`). Vendor retirement is an obs (tag \`vendor-retirement\`).

8. **Stated rules.** When Jose articulates a general rule ("Yonic is more experienced plumber", "Jimenez is our gate vendor", "Solomon Grauzinis requires approval for everything"), tag \`pm-stated-rule\` and use high salience (0.9+). These are gold for the belief former.

9. **Owner-only or vendor-only obs are fine.** A Darwin-retirement obs has only the vendor. A "Solomon Grauzinis requires approval for all issues" obs has only the owner. Don't force a property if none applies.

10. **Default to no obs when unclear.** Better to miss than fabricate.

Output strict JSON matching the schema. No prose.`;

const OBS_EXTRACT_SCHEMA = {
	name: 'session_observations',
	strict: false,
	schema: {
		type: 'object',
		additionalProperties: false,
		required: ['observations'],
		properties: {
			observations: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['title', 'summary', 'source_quote', 'entities', 'tags'],
					properties: {
						title: { type: 'string' },
						summary: { type: 'string' },
						source_quote: { type: 'string' },
						entities: {
							type: 'array',
							items: {
								type: 'object',
								additionalProperties: false,
								required: ['kind', 'name', 'weight'],
								properties: {
									kind: { type: 'string', enum: ['vendor', 'property', 'owner'] },
									name: { type: 'string' },
									weight: { type: 'number', minimum: -1, maximum: 1 }
								}
							}
						},
						tags: { type: 'array', items: { type: 'string' } },
						salience: { type: 'number' },
						source_message_id: { type: ['string', 'null'] }
					}
				}
			}
		}
	}
};

async function llmExtractObservations(messages) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('phase2: OPENAI_API_KEY not set');

	// Chunk if needed; for v1, also clip per call to MAX_MESSAGES_PER_LLM_CALL.
	const chunks = chunk(messages, MAX_MESSAGES_PER_LLM_CALL);
	const all = [];
	for (const part of chunks) {
		const transcript = part
			.map(
				(m) =>
					`[${m.ts}] (${m.source_guid}) ${effectiveSender(m.is_from_me, m.handle)}: ${m.body}`
			)
			.join('\n');
		const res = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model: OBSERVATION_MODEL,
				messages: [
					{ role: 'system', content: OBS_EXTRACT_SYSTEM },
					{ role: 'user', content: transcript }
				],
				response_format: { type: 'json_schema', json_schema: OBS_EXTRACT_SCHEMA },
				temperature: 0
			})
		});
		if (!res.ok) throw new Error(`phase2 LLM: ${res.status} ${await res.text()}`);
		const body = await res.json();
		const content = body?.choices?.[0]?.message?.content;
		try {
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed?.observations)) {
				for (const o of parsed.observations) all.push(o);
			}
			if (process.env.OBS_DEBUG) {
				console.log(`    [debug] LLM returned ${parsed?.observations?.length ?? 0} obs:`);
				console.log(JSON.stringify(parsed, null, 2));
			}
		} catch (err) {
			console.error('phase2: failed to parse LLM JSON:', err);
		}
	}
	return all;
}

function chunk(arr, n) {
	const out = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

async function phase2() {
	console.log(`\n[phase 2] fetching unprocessed sessions for ${chat_guid.slice(0, 16)}…`);
	const sessions = await fetchUnprocessedSessions();
	console.log(`[phase 2] ${sessions.length} sessions pending extraction`);

	if (sessions.length === 0) return { processed: 0, observations: 0 };

	const target = Math.min(sessions.length, limit);
	const est = (target * COST_PER_SESSION_USD).toFixed(2);
	console.log(
		`[phase 2] would process ${target} sessions, est. cost $${est} (midpoint $${COST_PER_SESSION_USD}/session)`
	);

	if (dryRun) {
		console.log(`[phase 2] --dry-run; printing first 3 transcripts and stopping`);
		for (const s of sessions.slice(0, 3)) {
			const msgs = await fetchSessionMessages(s.id);
			console.log(
				`\n  session ${s.id.slice(0, 8)} (${s.started_at.slice(0, 16)}, ${msgs.length} msgs)\n  summary: ${(s.summary || '').slice(0, 120)}`
			);
		}
		return { processed: 0, observations: 0 };
	}

	if (!confirmCost) {
		console.log(`[phase 2] add --confirm-cost to proceed with the LLM run.`);
		return { processed: 0, observations: 0 };
	}

	let processed = 0;
	let totalObs = 0;
	for (const s of sessions) {
		if (processed >= limit) {
			console.log(`[phase 2] hit --limit=${limit}, stopping`);
			break;
		}
		const msgs = await fetchSessionMessages(s.id);
		if (msgs.length < 2) {
			await patchSessionExtractedAt(s.id);
			processed++;
			continue;
		}
		try {
			const obs = await llmExtractObservations(msgs);
			for (const o of obs) {
				if (!o.title || !o.summary || !o.source_quote) continue;
				const salience = typeof o.salience === 'number' ? clamp01(o.salience) : 0.5;
				await memory.addObservation(workspace_id, {
					title: o.title,
					summary: o.summary,
					raw_text: o.source_quote,
					entities: Array.isArray(o.entities) ? o.entities : [],
					tags: Array.isArray(o.tags) ? o.tags : [],
					salience,
					source_message_id: o.source_message_id ?? null,
					session_id: s.id
				});
				totalObs++;
			}
			// Note: belief-former is decoupled from phase 2 — run
			// agent/scripts/backfill-beliefs.mjs separately to verify obs quality
			// before consolidation.
			await patchSessionExtractedAt(s.id);
			processed++;
			console.log(
				`  [+] session ${s.id.slice(0, 8)} (${msgs.length} msgs) → ${obs.length} observations`
			);
		} catch (err) {
			console.error(`  [!] session ${s.id.slice(0, 8)} failed: ${err.message}`);
			// Leave observations_extracted_at NULL so the next run retries.
		}
	}
	console.log(
		`[phase 2] done: processed=${processed} observations=${totalObs} est.cost=$${(processed * COST_PER_SESSION_USD).toFixed(2)}`
	);
	return { processed, observations: totalObs };
}

function clamp01(n) {
	if (!Number.isFinite(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

// ── phase entities: seed entity nodes from sessions ─────────────────────────
//
// Walks every session in this workspace, reads its transcript, asks an LLM
// to extract every named vendor / property / owner, and resolves each to an
// entity row (find-or-create). Run BEFORE observation extraction so that
// phase 2 can reference real entity IDs.

const ENTITY_SEED_SYSTEM = `You read a chat-session transcript between a property manager (Jose) and an AI agent coordinating maintenance work orders. Extract every named entity that belongs to one of three kinds:

- vendor: people or companies who perform maintenance work. Always extract the FULL name as the chat uses it ("JL Unlimited Services" not just "JL"; "Cross Appliance" not "Cross"). Treat first names referenced as workers as vendors (Abraham, Kori, Yonic — these are handymen/plumbers in this chat, NOT owners).
- property: named addresses or property nicknames where work orders happen. Examples: "Glencoe", "829 Ocean Park", "Mariposa", "6337 Primrose Ave", "180-10 11th St.". Use the FULL name. Skip unit numbers (those aren't entities).
- owner: legal owners or owner-groups that own properties. Examples: "Solomon Grauzinis Trust", "Harrison Properties". Owners are typically capitalized multi-word names ending in "Trust", "Properties", "LLC", or a family name. Individual first names like "Abraham" or "Kori" are NEVER owners.

Hard rules:
- Skip tenants, residents, and any person who is just receiving service.
- Skip generic role labels: "tree trimmer", "plumber", "electrician", "handyman", "the website guy", "the onsite manager". These describe roles, not entities. Only include if a NAMED vendor is used.
- Skip trade names like "plumbing", "electrical".
- Skip the agent's own messages or the PM's persona.
- When unsure if a name is a vendor or just a person mentioned in passing, skip it.
- Don't dedupe — emit every distinct name you see; resolveEntity handles fuzzy matching downstream.

Output strict JSON. If nothing fits, emit an empty array.`;

const ENTITY_SEED_SCHEMA = {
	name: 'session_entities',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		required: ['entities'],
		properties: {
			entities: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['kind', 'name'],
					properties: {
						kind: { type: 'string', enum: ['vendor', 'property', 'owner'] },
						name: { type: 'string' }
					}
				}
			}
		}
	}
};

// Upgraded from mini to full per user direction (2026-05-17). Entity
// extraction has a tricky disambiguation task (vendor first-names vs owner
// names, role labels to skip), mini was under-spec'd. Cost is still <$1 for
// the full Jose backfill.
const ENTITY_MODEL = process.env.ENTITY_EXTRACTOR_MODEL || 'gpt-5.4-2026-03-05';

async function llmExtractEntities(messages) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('phase entities: OPENAI_API_KEY not set');
	const transcript = messages
		.map(
			(m) =>
				`[${m.ts}] ${effectiveSender(m.is_from_me, m.handle)}: ${m.body}`
		)
		.join('\n');
	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: ENTITY_MODEL,
			messages: [
				{ role: 'system', content: ENTITY_SEED_SYSTEM },
				{ role: 'user', content: transcript }
			],
			response_format: { type: 'json_schema', json_schema: ENTITY_SEED_SCHEMA },
			temperature: 0
		})
	});
	if (!res.ok) throw new Error(`phase entities LLM: ${res.status} ${await res.text()}`);
	const body = await res.json();
	const content = body?.choices?.[0]?.message?.content;
	try {
		const parsed = JSON.parse(content);
		return Array.isArray(parsed?.entities) ? parsed.entities : [];
	} catch (err) {
		console.error('phase entities: failed to parse LLM JSON:', err);
		return [];
	}
}

// Per-session log for the entity walkthrough. Truncated on each phase-entities
// run so a re-run produces a clean log matching the current entities table.
const PHASE_ENTITIES_LOG = path.join(AGENT_ROOT, 'data', 'phase-entities-log.jsonl');

async function phaseEntities() {
	console.log(`\n[phase entities] seeding entities from sessions for ${chat_guid.slice(0, 16)}…`);
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,started_at,summary,message_count',
		workspace_id: `eq.${workspace_id}`,
		chat_guid: `eq.${chat_guid}`,
		order: 'started_at.asc'
	});
	const res = await fetch(`${url}/rest/v1/chat_sessions?${params}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`fetch sessions: ${res.status} ${await res.text()}`);
	const sessions = await res.json();
	console.log(`[phase entities] ${sessions.length} sessions to scan`);

	if (dryRun) {
		console.log('[phase entities] --dry-run; skipping');
		return { sessions: 0, entities_resolved: 0 };
	}
	if (!confirmCost) {
		console.log(
			`[phase entities] would scan ${sessions.length} sessions × mini model ≈ $${(sessions.length * 0.01).toFixed(2)}. Add --confirm-cost to run.`
		);
		return { sessions: 0, entities_resolved: 0 };
	}

	// Truncate the per-session log; we're starting a fresh run.
	await fs.mkdir(path.dirname(PHASE_ENTITIES_LOG), { recursive: true });
	await fs.writeFile(PHASE_ENTITIES_LOG, '');

	const before = await countEntities();
	let scanned = 0;
	let resolved = 0;
	let created = 0;
	let cascaded = 0;
	let cascadeMisses = 0;
	for (const s of sessions) {
		if (scanned >= limit) break;
		const msgs = await fetchSessionMessages(s.id);
		if (msgs.length < 2) {
			scanned++;
			continue;
		}
		const logEntry = {
			session_id: s.id,
			started_at: s.started_at,
			summary: s.summary ?? null,
			message_count: s.message_count ?? msgs.length,
			llm_emitted: [],
			resolved: [],
			cascaded: [],
			cascade_misses: [],
			extracted_at: new Date().toISOString()
		};
		try {
			const ents = await llmExtractEntities(msgs);
			logEntry.llm_emitted = ents.map((e) => ({ kind: e.kind, name: e.name }));
			let sessionCascaded = 0;
			let sessionMisses = 0;
			for (const e of ents) {
				try {
					const ent = await entitiesModule.resolveEntity({
						workspace_id,
						kind: e.kind,
						name: e.name
					});
					resolved++;
					if (ent.created) created++;
					logEntry.resolved.push({
						entity_id: ent.id,
						kind: ent.kind,
						name: ent.name,
						ref_table: ent.ref_table ?? null,
						ref_id: ent.ref_id ?? null,
						created: !!ent.created,
						llm_name: e.name // what the LLM emitted, may differ from resolved name
					});

					// Property → owner cascade. Only fires when the property has
					// legacy ref_id (i.e. matched a row in `properties`); informal
					// properties from passing chat mentions stay orphans.
					if (ent.kind === 'property') {
						if (ent.ref_id) {
							const owners = await entitiesModule.cascadeOwners(ent, workspace_id);
							if (owners.length === 0) {
								// Property has a legacy row but no owner_properties links.
								sessionMisses++;
								cascadeMisses++;
								logEntry.cascade_misses.push({
									property_entity_id: ent.id,
									property_name: ent.name,
									reason: 'no_owner_properties_rows'
								});
							}
							for (const o of owners) {
								resolved++;
								if (o.created) created++;
								sessionCascaded++;
								cascaded++;
								logEntry.cascaded.push({
									entity_id: o.id,
									kind: o.kind,
									name: o.name,
									from_property_entity_id: ent.id,
									from_property_name: ent.name,
									created: !!o.created
								});
							}
						} else {
							sessionMisses++;
							cascadeMisses++;
							logEntry.cascade_misses.push({
								property_entity_id: ent.id,
								property_name: ent.name,
								reason: 'no_legacy_ref_id'
							});
						}
					}
				} catch (err) {
					console.error(`  resolveEntity(${e.kind}, ${e.name}) failed: ${err.message}`);
				}
			}
			console.log(
				`  [+] session ${s.id.slice(0, 8)} → ${ents.length} mentions, ${sessionCascaded} cascaded owners, ${sessionMisses} cascade misses`
			);
		} catch (err) {
			console.error(`  [!] session ${s.id.slice(0, 8)} failed: ${err.message}`);
		}
		await fs.appendFile(PHASE_ENTITIES_LOG, JSON.stringify(logEntry) + '\n');
		scanned++;
	}
	const after = await countEntities();
	console.log(
		`[phase entities] done: sessions=${scanned} mentions_resolved=${resolved} created=${created} cascaded=${cascaded} cascade_misses=${cascadeMisses} (entities: ${before} → ${after})`
	);
	return { sessions: scanned, entities_resolved: resolved, created, cascaded, cascade_misses: cascadeMisses };
}

async function countEntities() {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id',
		workspace_id: `eq.${workspace_id}`
	});
	const res = await fetch(`${url}/rest/v1/entities?${params}`, {
		headers: {
			apikey: key,
			Authorization: `Bearer ${key}`,
			Prefer: 'count=exact',
			Accept: 'application/json',
			Range: '0-0'
		}
	});
	if (!res.ok) return -1;
	const cr = res.headers.get('content-range');
	return cr ? Number(cr.split('/')[1]) : -1;
}

// ── phase beliefs: shim → calls backfill-beliefs.mjs via runBeliefFormer ────

async function phaseBeliefs() {
	console.log(`\n[phase beliefs] running entity-aware belief-former across unconsolidated observations…`);
	if (dryRun) {
		console.log('[phase beliefs] --dry-run; skipping');
		return { processed: 0 };
	}
	if (!confirmCost) {
		console.log(`[phase beliefs] add --confirm-cost to run.`);
		return { processed: 0 };
	}
	const { url, key } = supabaseEnv();
	// Observations that have no belief_evidence yet.
	const res = await fetch(
		`${url}/rest/v1/observations?select=id,ts,summary,belief_evidence(observation_id)&workspace_id=eq.${workspace_id}&order=ts.asc&limit=2000`,
		{ headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } }
	);
	if (!res.ok) throw new Error(`fetch observations: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	const pending = rows.filter((r) => !r.belief_evidence || r.belief_evidence.length === 0);
	console.log(`[phase beliefs] ${pending.length} unconsolidated observations`);

	let done = 0;
	for (const obs of pending) {
		if (done >= limit) break;
		try {
			const result = await runBeliefFormer(workspace_id, obs.id);
			const ops = result?.ops ?? [];
			const tally = ops.map((o) => o.action).join(',') || 'noop';
			console.log(
				`  [+] ${obs.id.slice(0, 8)} (${(obs.summary || '').slice(0, 70)}) → ${tally}`
			);
		} catch (err) {
			console.error(`  [!] ${obs.id.slice(0, 8)} failed: ${err.message}`);
		}
		done++;
	}
	console.log(`[phase beliefs] done: processed=${done}`);
	return { processed: done };
}

// ── main ─────────────────────────────────────────────────────────────────────

const summary = { phase1: null, phaseEntities: null, phase2: null, phaseBeliefs: null };

if (phaseArg === '1' || phaseArg === 'all') {
	summary.phase1 = await phase1();
}
if (phaseArg === 'entities' || phaseArg === 'all') {
	summary.phaseEntities = await phaseEntities();
}
if (phaseArg === '2' || phaseArg === 'all') {
	summary.phase2 = await phase2();
}
if (phaseArg === 'beliefs' || phaseArg === 'all') {
	summary.phaseBeliefs = await phaseBeliefs();
}

console.log(`\nsummary: ${JSON.stringify(summary, null, 2)}`);
