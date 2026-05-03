#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(SCRIPT_DIR, 'owner-chat.csv');

// Chat room containing 3106990643 and 9496566275
const ROOM_NAME = '800f91610cea448fb5085603ab3ea973';

const SENDER_LABELS = {
	'+13106990643': 'Property Manager',
	'+19496566275': 'AI Agent (949)',
	'+16504443716': 'AI Agent (650)',
	me: 'AI Agent (me)'
};

// Apple's iMessage epoch starts at 2001-01-01
const APPLE_EPOCH_OFFSET = 978307200;

function appleTimestampToDate(ts) {
	if (!ts) return '';
	// Newer macOS stores nanoseconds
	const seconds = ts > 1e10 ? ts / 1e9 : ts;
	return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000).toISOString();
}

function csvEscape(val) {
	if (val == null) return '';
	const str = String(val);
	if (str.includes(',') || str.includes('"') || str.includes('\n')) {
		return '"' + str.replace(/"/g, '""') + '"';
	}
	return str;
}

const sql = `
SELECT
  m.ROWID        AS rowid,
  m.date         AS apple_ts,
  m.is_from_me   AS is_from_me,
  h.id           AS handle,
  m.text         AS text
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
WHERE c.room_name = '${ROOM_NAME}'
  AND m.text IS NOT NULL
  AND trim(m.text) != ''
ORDER BY m.ROWID ASC;
`;

const { stdout } = await execFileAsync('sqlite3', ['-json', CHAT_DB_PATH, sql]);
const rows = JSON.parse(stdout.trim() || '[]');

const lines = ['rowid,timestamp,sender,message'];
for (const row of rows) {
	const sender = row.is_from_me ? SENDER_LABELS['me'] : (SENDER_LABELS[row.handle] ?? row.handle);
	const ts = appleTimestampToDate(row.apple_ts);
	lines.push([row.rowid, ts, sender, row.text].map(csvEscape).join(','));
}

await fs.writeFile(OUTPUT_PATH, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${rows.length} messages to ${OUTPUT_PATH}`);
