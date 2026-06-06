// One-off: re-run a single work order through processNewWorkOrder without
// touching the poller cursor. Usage: node scripts/_reprocess-wo.mjs <issue_id>
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(SCRIPT_DIR, '..');

async function loadDotEnv(file) {
	try {
		const raw = await fs.readFile(file, 'utf8');
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

await loadDotEnv(path.join(AGENT_DIR, '..', '.env'));
await loadDotEnv(path.join(AGENT_DIR, '.env'));

const { WORKSPACES } = await import('../core/workspaces.mjs');
const { processNewWorkOrder } = await import('../triggers/new-work-order-message.mjs');

const issue_id = process.argv[2];
if (!issue_id) throw new Error('usage: node scripts/_reprocess-wo.mjs <issue_id>');

const { supabaseEnv } = await import('../core/supabase.mjs');
const { url, key } = supabaseEnv();

const res = await fetch(
	`${url}/rest/v1/issues_v2?id=eq.${issue_id}&select=id,workspace_id,appfolio_srn,urgent,created_at`,
	{ headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } }
);
const [row] = await res.json();
if (!row) throw new Error(`issue not found: ${issue_id}`);

const ws = WORKSPACES[row.workspace_id];
if (!ws) throw new Error(`unknown workspace: ${row.workspace_id}`);
const chatGuid = process.env[ws.chatEnv] ?? null;
if (!chatGuid) throw new Error(`no ${ws.chatEnv} set for workspace=${ws.label}`);

const db = new Database(path.join(os.homedir(), 'Library', 'Messages', 'chat.db'), {
	readonly: true,
	fileMustExist: true
});
const participants = db
	.prepare(
		`SELECT h.id FROM chat c
		 JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
		 JOIN handle h ON h.ROWID = chj.handle_id
		 WHERE c.guid = ?`
	)
	.all(chatGuid)
	.map((r) => r.id)
	.filter(Boolean);

console.log(`reprocessing ${issue_id} workspace=${ws.label} srn=${row.appfolio_srn}`);
const result = await processNewWorkOrder({
	issue_id: row.id,
	workspace_id: row.workspace_id,
	workspace: ws,
	chatGuid,
	participants
});

if (!result.ok) {
	console.log('FAILED', JSON.stringify(result.failure));
	process.exit(1);
}
console.log('OK', {
	draft_id: result.draft.id,
	urgent: result.issue.urgent,
	urgency_reason: result.issue.urgency_reason
});
console.log('--- draft body ---');
console.log(result.draft.messages?.map((m) => m.body).join('\n'));
process.exit(0);
