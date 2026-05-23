// Trigger: polls macOS Messages chat.db for new inbound iMessages, routes each
// new row to the orchestrator as one of two AgentEvents:
//
//   - pm_reply       — message from a mapped groupchat's PM handle
//                      (workspace lookup hits chatGuidIndex)
//   - demo_message   — message from an unknown 1:1 handle (style 45,
//                      no room_name, not in knownNumbers)
//
// Side-effects per turn:
//   - Sessionize the message into the memory-graph (prod workspace only).
//   - Append PM groupchat messages to chat-log via state helpers, then patch
//     the row with the agent's action after the turn completes.
//   - Read receipts fire immediately on observation (before any LLM work).
//   - Typing dots fire ONLY immediately before each outbound message bubble
//     (NOT on the orchestrator's `typing` event — see comment on onEvent).
//
// Inputs (from server.mjs):
//   { helper, chatGuidIndex, log }
//     helper:        the imessage helper for markRead / setTyping / send /
//                    react / isConnected / ping
//     chatGuidIndex: Map<chat_guid, { workspace_id, label, pm_handles }>
//                    built by buildChatGuidIndex() at server startup
//     log:           formatted logger used across the server
//
// Cursor + dedup state lives in <agent>/.imessage-state.json:
//   { lastSeenRowId: number, processed: { [message_guid]: unix_ms } }

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runTurn } from '../core/orchestrator.mjs';
import { appendChatMessage, updateChatMessage } from '../state/helpers.mjs';
import * as sessionizer from '../core/sessionizer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POLL_INTERVAL_MS = 1000;
const HELPER_ENABLED = process.env.HELPER_DISABLED !== '1';
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
// STATE_PATH is at agent/.imessage-state.json (sibling of triggers/).
const STATE_PATH = path.join(__dirname, '..', '.imessage-state.json');

// Simulated typing pace: dots stay on for this long before each message ships.
// Scales with message length so a 4-word reply doesn't feel as instant as a
// 30-word one. Tuned to feel snappy but not robotic — adjust to taste.
const TYPING_MIN_MS = 300;
const TYPING_PER_CHAR_MS = 25;
const TYPING_MAX_MS = 2000;

function typingDwellMs(text) {
	const n = (text ?? '').length;
	return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, n * TYPING_PER_CHAR_MS));
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// Real customer/vendor handles — incoming messages from these are ignored on
// the 1:1 demo path so testing doesn't hijack real conversations. Mapped
// groupchat traffic is gated separately by chatGuidIndex.
const KNOWN_NUMBERS = [
	'+13106990643', // Jose / property manager
	'+13102663152' // Jose (other number)
];
const knownSet = new Set(KNOWN_NUMBERS.map(normalizeHandle));

const DEMO_HANDLE = process.env.DEMO_HANDLE ? normalizeHandle(process.env.DEMO_HANDLE) : null;

// ── handle normalization ───────────────────────────────────────────────────────

function shortHandle(h) {
	if (!h) return h;
	if (h.includes('@')) return h; // emails: leave intact, letters and all
	return h.replace(/^\+1/, '').replace(/[^\d@.]/g, '') || h;
}

function normalizeHandle(raw) {
	if (!raw) return '';
	const value = String(raw).trim();
	if (!value) return '';
	if (value.includes('@')) return value.toLowerCase();
	const digitsOnly = value.replace(/[^\d+]/g, '');
	if (digitsOnly.startsWith('+')) return `+${digitsOnly.slice(1).replace(/\D/g, '')}`;
	const digits = digitsOnly.replace(/\D/g, '');
	if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
	if (digits.length === 10) return `+1${digits}`;
	if (digits.length > 0) return `+${digits}`;
	return value.toLowerCase();
}

// ── chat.db ────────────────────────────────────────────────────────────────────

let db = null;

function getDb() {
	if (!db) db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
	return db;
}

// macOS Ventura+ stores message text in attributedBody (NSAttributedString
// streamtyped binary). Scan for the longest printable UTF-8 run between the
// "NSString" class marker and the next attribute-class marker. Kept in sync
// with agent/scripts/backfill-from-chat.mjs.
function extractText(row) {
	if (row.text) return row.text;
	const blob = row.attributedBody;
	if (!blob || !Buffer.isBuffer(blob)) return null;

	const stringMarker = Buffer.from('NSString');
	const stringIdx = blob.indexOf(stringMarker);
	if (stringIdx < 0) return null;

	const endMarkers = ['NSDictionary', 'NSNumber', 'NSValue', '__kIM', '_kIM'];
	let endIdx = blob.length;
	for (const m of endMarkers) {
		const idx = blob.indexOf(Buffer.from(m), stringIdx + stringMarker.length);
		if (idx >= 0 && idx < endIdx) endIdx = idx;
	}

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
	// Apple short-string encoding leaks through as "+ [len-byte] [string]" when
	// the length byte is printable ASCII (lengths 32–126). Detect & strip.
	if (text.length >= 2 && text.charCodeAt(0) === 0x2b) {
		const lenByte = text.charCodeAt(1);
		if (lenByte >= 1 && lenByte <= 127 && lenByte <= text.length - 2) {
			text = text.slice(2, 2 + lenByte);
		}
	}
	text = text
		.replace(/^[\x01-\x1f\x7f]+/, '')
		.replace(/[�\x01-\x1f\x7f]+$/, '')
		.trim();
	return text || null;
}

// 978307200000 = ms since unix epoch for 2001-01-01 UTC. Apple stores
// message.date as nanoseconds since 2001 on Sierra+. Older schemas used
// seconds; the magnitude check handles both.
const APPLE_EPOCH_MS = 978307200000;
function appleDateToISO(date) {
	const n = Number(date);
	if (!Number.isFinite(n) || n <= 0) return null;
	const ms = n > 1e10 ? APPLE_EPOCH_MS + n / 1e6 : APPLE_EPOCH_MS + n * 1000;
	return new Date(ms).toISOString();
}

function fetchLatestRowId(log) {
	try {
		const row = getDb().prepare('SELECT COALESCE(MAX(ROWID),0) AS max_rowid FROM message').get();
		return Number(row?.max_rowid ?? 0);
	} catch (err) {
		log(`db error: ${err.message}`);
		return 0;
	}
}

// SQL accepts two kinds of rows:
//   1) 1:1 direct messages (style 45, no room_name) — demo path.
//   2) Any chat whose guid is in `groupchatGuids` — work-orders path.
// The IN-list is built from the chatGuidIndex so it picks up TEST_CHAT_GUID
// and JOSE_CHAT_GUID without having to special-case style 43 vs 45.
function fetchNewMessages(afterRowId, groupchatGuids, log) {
	try {
		const placeholders = groupchatGuids.map(() => '?').join(',');
		const groupBranch = placeholders ? `OR c.guid IN (${placeholders})` : '';
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
			  AND (
			    (c.style = 45 AND c.room_name IS NULL)
			    ${groupBranch}
			  )
			ORDER BY m.ROWID ASC
			LIMIT 100
		`;
		const rows = getDb()
			.prepare(sql)
			.all(Number(afterRowId) || 0, ...groupchatGuids);
		return rows.map((r) => ({ ...r, text: extractText(r) }));
	} catch (err) {
		log(`db error: ${err.message}`);
		return [];
	}
}

// ── Module ─────────────────────────────────────────────────────────────────────

export async function startChatPoller({ helper, chatGuidIndex, log }) {
	const groupchatGuids = [...chatGuidIndex.keys()];

	// ── State ────────────────────────────────────────────────────────────────────

	const state = { lastSeenRowId: 0, processed: {} };

	async function loadState() {
		try {
			const raw = await fs.readFile(STATE_PATH, 'utf8');
			const parsed = JSON.parse(raw);
			state.lastSeenRowId = Number(parsed.lastSeenRowId ?? 0);
			state.processed = parsed.processed ?? {};
		} catch {
			state.lastSeenRowId = fetchLatestRowId(log);
			state.processed = {};
			await saveState();
		}
	}

	async function saveState() {
		const entries = Object.entries(state.processed).sort((a, b) => b[1] - a[1]);
		state.processed = Object.fromEntries(entries.slice(0, 2000));
		await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
	}

	// ── Helper signals ───────────────────────────────────────────────────────────

	async function markRead(chatGuid) {
		if (!HELPER_ENABLED) return;
		const r = await helper.markRead(chatGuid);
		if (!r.ok) log(`markRead failed: ${r.error}`);
	}

	async function setTyping(chatGuid, typing) {
		if (!HELPER_ENABLED) return;
		const r = await helper.setTyping(chatGuid, typing);
		if (!r.ok) log(`setTyping(${typing}) failed: ${r.error}`);
	}

	async function sendPart(chatGuid, text) {
		const r = await helper.send(chatGuid, text);
		if (!r.ok) log(`send failed: ${r.error}`);
		return r.ok;
	}

	// ── Per-message handlers ─────────────────────────────────────────────────────

	async function handleIncoming(row) {
		const handle = normalizeHandle(row.handle);
		const chatGuid = row.chat_guid || '';
		const text = String(row.text || '').trim();
		if (!text) return;
		if (DEMO_HANDLE && handle !== DEMO_HANDLE) return;
		if (knownSet.has(handle)) return;

		log(`← ${shortHandle(handle)}: "${text}"`);

		// Fire the read receipt the moment we observe the message — before any
		// agent work happens. This is independent of whatever skill runs and
		// whether the orchestrator emits a 'read' event. The user sees "Read"
		// immediately on every incoming message.
		await markRead(chatGuid);

		// Dots come on ONLY immediately before a real message ships — never on
		// the orchestrator's `typing` event itself. The orchestrator emits a
		// typing event at the start of every iteration including the final
		// no-op one (where the model returns no more tool calls), so reacting
		// to that event causes a ghost flash. Tying dots to actual messages
		// mirrors how real iMessage typing indicators behave: you don't see
		// "..." while the other person is just thinking, you see them when
		// they're actively composing the next bubble.
		const onEvent = async (ev) => {
			if (ev.type === 'read') {
				await markRead(chatGuid);
			} else if (ev.type === 'typing') {
				// Intentional no-op. See above.
			} else if (ev.type === 'message') {
				await setTyping(chatGuid, true);
				await sleep(typingDwellMs(ev.content));
				await setTyping(chatGuid, false);
				const ok = await sendPart(chatGuid, ev.content);
				if (ok) log(`→ ${shortHandle(handle)}: "${ev.content}"`);
			} else if (ev.type === 'tool_call') {
				const args = JSON.stringify(ev.args ?? {});
				log(`  · ${ev.name}(${args.length > 80 ? args.slice(0, 77) + '...' : args})`);
			}
		};

		// react closure for the orchestrator's send_reaction tool. Bound to this
		// specific incoming message — the LLM doesn't need to know GUIDs.
		const react = async (reactionType) => {
			if (!HELPER_ENABLED) return { ok: false, error: 'helper disabled' };
			const r = await helper.react(chatGuid, row.guid, reactionType, text);
			if (!r.ok) log(`react(${reactionType}) failed: ${r.error}`);
			else log(`  · react ${reactionType} -> "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`);
			return r;
		};

		try {
			const event = { type: 'demo_message', payload: { text, handle, msg_guid: row.guid } };
			await runTurn(event, {
				handle,
				text,
				chatGuid,
				onEvent,
				react,
				sendMode: 'live',
				// Demo path is unknown 1:1 handles only. knownSet filtered above
				// rejects PM numbers before we get here. Belt-and-suspenders flag
				// for the send_text safety guard.
				isPmHandle: false
			});
		} catch (err) {
			log(`turn error: ${err.message}`);
		} finally {
			// Defensive: kill dots in case anything left them on (e.g., we threw
			// during the dwell sleep before the typing-off call).
			await setTyping(chatGuid, false);
		}
	}

	// Mapped groupchat: append to chat-log (permanent record), fire read
	// receipt, run the pm_reply event, then patch the chat-log row with the
	// agent's resulting action (drafted/no_match/failure).
	async function handleGroupchatMessage(row, ws) {
		const handle = normalizeHandle(row.handle);
		const chatGuid = row.chat_guid;
		const text = String(row.text || '').trim();
		if (!text) return;

		await appendChatMessage({
			message_guid: row.guid,
			chat_guid: chatGuid,
			workspace_id: ws.workspace_id,
			workspace_label: ws.label,
			handle,
			text,
			is_from_me: false,
			db_date: Number(row.date) || null
		});
		const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
		log(`◉ ${ws.label} ← ${shortHandle(handle)}: "${preview}"`);

		await markRead(chatGuid);

		const onEvent = async (ev) => {
			if (ev.type === 'read') {
				await markRead(chatGuid);
			} else if (ev.type === 'message') {
				await setTyping(chatGuid, true);
				await sleep(typingDwellMs(ev.content));
				await setTyping(chatGuid, false);
				const ok = await sendPart(chatGuid, ev.content);
				if (ok) log(`→ ${ws.label}: "${ev.content}"`);
			} else if (ev.type === 'tool_call') {
				const args = JSON.stringify(ev.args ?? {});
				log(`  · ${ev.name}(${args.length > 80 ? args.slice(0, 77) + '...' : args})`);
			}
		};

		// Pull the live session_id from the sessionizer cache (already populated
		// by the parallel sessionizer.ingestMessage call for this same row).
		// session_id rides on ctx so write_memory can stamp it on the observation.
		// If the sessionizer hasn't run yet for this chat (rare race), session_id
		// is null and write_memory still functions — the obs just won't be linked.
		const openSession = await sessionizer.getOpenSession(chatGuid).catch(() => null);
		const session_id = openSession?.session_id ?? null;

		const ctx = {
			handle,
			text,
			chat_guid: chatGuid,
			workspace_id: ws.workspace_id,
			workspace_label: ws.label,
			onEvent,
			sendMode: 'live', // ack texts go live; draft_tenant/draft_vendor still write drafts
			// Groupchat with a PM is NOT a 1:1 with a PM. The send_text safety
			// guard (refuse live + isPmHandle) is about preventing direct DMs;
			// short ack phrases ("got it", "on it") are explicitly intended here.
			isPmHandle: false,
			session_id,
			source_message_id: row.guid ?? null
		};

		const event = {
			type: 'pm_reply',
			payload: { text, chat_guid: chatGuid, sender_handle: handle, msg_guid: row.guid ?? null }
		};
		let result;
		let runError = null;
		try {
			result = await runTurn(event, ctx);
		} catch (err) {
			runError = err;
			log(`pm_reply error: ${err.message}`);
		} finally {
			await setTyping(chatGuid, false);
		}

		const draftIds = ctx.draftIds ?? [];
		const draftsCreated = draftIds.length;
		const action = runError
			? 'failure'
			: result?.failure
				? 'failure'
				: draftsCreated > 0
					? 'drafted'
					: 'no_match';

		await updateChatMessage(row.guid, {
			agent_action: action,
			agent_runs_at: new Date().toISOString(),
			agent_drafts_count: draftsCreated,
			agent_draft_ids: draftIds,
			agent_error: runError?.message ?? result?.failure?.error ?? null
		});
		log(`◉ ${ws.label} agent: ${action}${draftsCreated ? ` (${draftsCreated} drafts)` : ''}`);
	}

	// ── Poll loop ────────────────────────────────────────────────────────────────

	let polling = false;
	const inflight = new Map(); // handle/chat_guid -> Promise; serializes turns

	// Sessionizer ingest queue: per-chat Promise chain so boundary calls land in
	// chronological order without blocking the poll loop. Only the prod
	// groupchat is sessionized today — see shouldSessionize().
	const sessionizerInflight = new Map();

	function shouldSessionize(ws) {
		return ws?.label === 'prod';
	}

	function queueSessionize(workItem, ws) {
		if (!shouldSessionize(ws)) return;
		const key = workItem.chat_guid;
		const prev = sessionizerInflight.get(key) ?? Promise.resolve();
		const next = prev
			.then(() => sessionizer.ingestMessage(workItem))
			.catch((err) => log(`sessionizer error: ${err.message}`));
		sessionizerInflight.set(key, next);
		next.finally(() => {
			if (sessionizerInflight.get(key) === next) sessionizerInflight.delete(key);
		});
	}

	async function pollOnce() {
		const rows = fetchNewMessages(state.lastSeenRowId, groupchatGuids, log);
		if (!rows.length) return;

		for (const row of rows) {
			state.lastSeenRowId = Math.max(state.lastSeenRowId, Number(row.rowid) || 0);
			if (state.processed[row.guid]) continue;
			state.processed[row.guid] = Date.now();

			const handle = normalizeHandle(row.handle);
			const chatGuid = row.chat_guid || '';
			const ws = chatGuidIndex.get(chatGuid);
			const isFromMe = Number(row.is_from_me) === 1;

			// Sessionize first — runs in a per-chat queue, doesn't block the rest
			// of the loop. Captures BOTH directions and all senders in scope (not
			// just PM handles) so the persisted transcript matches chat.db
			// faithfully.
			if (ws && shouldSessionize(ws)) {
				const text = String(row.text || '').trim();
				const ts = appleDateToISO(row.date);
				if (text && ts) {
					queueSessionize(
						{
							workspace_id: ws.workspace_id,
							chat_guid: chatGuid,
							handle,
							is_from_me: isFromMe,
							body: text,
							ts,
							source_rowid: Number(row.rowid),
							source_guid: row.guid,
							issue_id: null
						},
						ws
					);
				}
			}

			// Outgoing messages stop here — sent by us, no skill to run.
			if (isFromMe) continue;

			if (ws) {
				// Mapped groupchat. Only store messages from the PM; ignore
				// tenant/owner replies for now (correlator design only triggers
				// on PM).
				if (!ws.pm_handles.has(handle)) continue;
				const key = chatGuid;
				const prev = inflight.get(key) ?? Promise.resolve();
				const next = prev
					.then(() => handleGroupchatMessage(row, ws))
					.catch((err) => log(`groupchat handle error: ${err.message}`));
				inflight.set(key, next);
				next.finally(() => {
					if (inflight.get(key) === next) inflight.delete(key);
				});
				continue;
			}

			// Groupchat we don't recognize — drop. (Demo path is 1:1 only.)
			if (row.room_name) continue;
			// Demo path. Real customer/vendor numbers (knownSet) are dropped so
			// testing doesn't hijack real conversations.
			if (knownSet.has(handle)) continue;

			const prev = inflight.get(handle) ?? Promise.resolve();
			const next = prev
				.then(() => handleIncoming(row))
				.catch((err) => log(`handle error: ${err.message}`));
			inflight.set(handle, next);
			next.finally(() => {
				if (inflight.get(handle) === next) inflight.delete(handle);
			});
		}

		await saveState();
	}

	// ── Boot ─────────────────────────────────────────────────────────────────────

	await loadState();
	if (DEMO_HANDLE) log(`scoped to DEMO_HANDLE=${DEMO_HANDLE}`);
	log(`chat poller started (poll=${POLL_INTERVAL_MS}ms, lastRow=${state.lastSeenRowId})`);

	setInterval(async () => {
		if (polling) return;
		polling = true;
		try {
			await pollOnce();
		} catch (err) {
			log(`poll error: ${err.message}`);
		} finally {
			polling = false;
		}
	}, POLL_INTERVAL_MS);
}
