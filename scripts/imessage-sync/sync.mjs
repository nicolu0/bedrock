#!/usr/bin/env node
// iMessage → Bedrock sync. Runs on your Mac, reads ~/Library/Messages/chat.db
// read-only, POSTs new messages from a single configured group chat to the
// Bedrock ingest endpoint. Never reads or uploads anything outside that chat.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

let Database;
try {
	({ default: Database } = await import('better-sqlite3'));
} catch {
	console.error('Missing dependency: better-sqlite3. Run `npm install better-sqlite3` in this folder.');
	process.exit(1);
}

const CONFIG_DIR = path.join(os.homedir(), '.bedrock-imessage');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE_PATH = path.join(CONFIG_DIR, 'state.json');
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = 200;

function readJson(p, fallback) {
	try {
		return JSON.parse(fs.readFileSync(p, 'utf-8'));
	} catch {
		return fallback;
	}
}

function writeJson(p, data) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// Apple epoch: 2001-01-01 UTC. message.date is nanoseconds since that epoch
// (older macOS used seconds; we detect by magnitude).
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
function appleDateToIso(raw) {
	if (raw == null) return null;
	const n = Number(raw);
	if (!Number.isFinite(n)) return null;
	// Heuristic: ns values are > 1e15 in modern macOS, seconds < 1e10.
	const ms = n > 1e14 ? n / 1e6 : n * 1000;
	return new Date(APPLE_EPOCH_MS + ms).toISOString();
}

function loadConfig() {
	if (!fs.existsSync(CONFIG_PATH)) {
		console.error(`Missing config at ${CONFIG_PATH}. Run install.sh first.`);
		process.exit(1);
	}
	const cfg = readJson(CONFIG_PATH, null);
	const required = ['api_key', 'api_base', 'chat_guid'];
	for (const key of required) {
		if (!cfg?.[key]) {
			console.error(`Config missing required field: ${key}`);
			process.exit(1);
		}
	}
	return cfg;
}

function openDb() {
	if (!fs.existsSync(CHAT_DB_PATH)) {
		console.error(`chat.db not found at ${CHAT_DB_PATH}`);
		process.exit(1);
	}
	try {
		return new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
	} catch (err) {
		console.error('Failed to open chat.db (grant Full Disk Access to your node runtime):', err.message);
		process.exit(1);
	}
}

function queryNewMessages(db, chatGuid, sinceRowid) {
	const stmt = db.prepare(`
		SELECT m.ROWID AS rowid,
		       m.guid AS guid,
		       m.text AS text,
		       m.attributedBody AS attributed_body,
		       m.is_from_me AS is_from_me,
		       m.date AS date_raw,
		       h.id AS sender_handle
		FROM message m
		JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
		JOIN chat c ON c.ROWID = cmj.chat_id
		LEFT JOIN handle h ON h.ROWID = m.handle_id
		WHERE c.guid = ?
		  AND m.ROWID > ?
		ORDER BY m.ROWID ASC
		LIMIT ?
	`);
	return stmt.all(chatGuid, sinceRowid ?? 0, LIMIT);
}

// Decode the body string out of a NeXT typedstream-encoded attributedBody blob.
// Modern iMessages (iOS 16+) store the message body here instead of `text`.
// The body is an NSString instance serialized as:  0x2B <varlen> <UTF-8 bytes>
// where varlen is: if first byte < 0x80, that byte is the length; if 0x81,
// next 2 bytes little-endian; if 0x82, next 4 bytes little-endian.
// We find the first valid-looking candidate after the NSString class marker.
function decodeAttributedBody(buf) {
	if (!buf || !buf.length) return null;
	const marker = Buffer.from('NSString');
	const markerIdx = buf.indexOf(marker);
	if (markerIdx === -1) return null;

	const readLenAt = (i) => {
		const first = buf[i];
		if (first === undefined) return null;
		if (first < 0x80) return { len: first, next: i + 1 };
		if (first === 0x81 && i + 2 < buf.length) {
			return { len: buf.readUInt16LE(i + 1), next: i + 3 };
		}
		if (first === 0x82 && i + 4 < buf.length) {
			return { len: buf.readUInt32LE(i + 1), next: i + 5 };
		}
		return null;
	};

	let plus = buf.indexOf(0x2b, markerIdx + marker.length);
	while (plus !== -1) {
		const lenInfo = readLenAt(plus + 1);
		if (lenInfo && lenInfo.len > 0 && lenInfo.next + lenInfo.len <= buf.length) {
			const slice = buf.subarray(lenInfo.next, lenInfo.next + lenInfo.len);
			const text = slice.toString('utf8');
			// Reject obvious metadata hits (classes like iI, NSDictionary, etc).
			let printable = 0;
			for (let i = 0; i < text.length; i++) {
				const code = text.charCodeAt(i);
				if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) printable += 1;
			}
			if (text.length && printable / text.length > 0.9 && !/^[A-Z][A-Za-z0-9]+$/.test(text)) {
				return text;
			}
		}
		plus = buf.indexOf(0x2b, plus + 1);
	}
	return null;
}

function extractText(row) {
	if (row.text && row.text.trim()) return row.text;
	if (row.attributed_body) {
		const decoded = decodeAttributedBody(row.attributed_body);
		if (decoded && decoded.trim()) return decoded;
	}
	return null;
}

async function postBatch(config, messages) {
	const res = await fetch(`${config.api_base.replace(/\/+$/, '')}/api/imessage/ingest`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.api_key}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ messages })
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Ingest failed ${res.status}: ${text}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}

async function main() {
	const config = loadConfig();
	const state = readJson(STATE_PATH, { last_rowid: 0 });
	const db = openDb();

	const rows = queryNewMessages(db, config.chat_guid, state.last_rowid);
	if (!rows.length) {
		console.log(`[${new Date().toISOString()}] no new messages (cursor rowid=${state.last_rowid})`);
		db.close();
		return;
	}

	const payload = [];
	let maxRowid = state.last_rowid ?? 0;
	let skippedAttributed = 0;
	for (const row of rows) {
		maxRowid = Math.max(maxRowid, row.rowid);
		const text = extractText(row);
		if (!text) {
			if (row.attributed_body) skippedAttributed += 1;
			continue;
		}
		payload.push({
			guid: row.guid,
			rowid: row.rowid,
			text,
			is_from_me: row.is_from_me ? 1 : 0,
			date_iso: appleDateToIso(row.date_raw),
			sender_handle: row.sender_handle ?? null
		});
	}
	db.close();

	console.log(
		`[${new Date().toISOString()}] rows=${rows.length} to_send=${payload.length} skipped_attributed=${skippedAttributed}`
	);

	if (DRY_RUN) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	if (payload.length) {
		const result = await postBatch(config, payload);
		console.log('ingest result:', result);
	}

	writeJson(STATE_PATH, { last_rowid: maxRowid });
}

main().catch((err) => {
	console.error('sync failed:', err.message);
	process.exit(1);
});
