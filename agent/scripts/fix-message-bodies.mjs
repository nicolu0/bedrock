#!/usr/bin/env node
// One-off: re-extract chat_messages.body from chat.db with the corrected
// extractText, and PATCH any row whose body differs. Sessions, summaries,
// and curation are left untouched. Safe to re-run.
//
// Usage:
//   node agent/scripts/fix-message-bodies.mjs --workspace=prod [--dry-run]

import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(AGENT_ROOT, '..');

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

const args = process.argv.slice(2);
function arg(name) {
	for (const a of args) {
		if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
		if (a === `--${name}`) return true;
	}
	return null;
}

const WORKSPACE_LABELS = {
	prod: '2e4373a0-40b8-42c2-a873-b08c99dbf76a',
	test: '40d675ba-4dec-47dd-9222-79c0345c493f'
};
const wsArg = arg('workspace');
const dryRun = arg('dry-run') === true;
if (!wsArg) {
	console.error('usage: --workspace=<prod|test|uuid> [--dry-run]');
	process.exit(2);
}
const workspace_id = WORKSPACE_LABELS[wsArg] ?? wsArg;
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
	console.error('SUPABASE_SERVICE_ROLE_KEY not set');
	process.exit(2);
}

// Corrected extractText — heuristic version that finds the longest printable
// UTF-8 run between "NSString" and the next attribute-class marker. Mirrors
// agent/scripts/backfill-from-chat.mjs and agent/server.mjs.
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

const CHAT_DB = new Database(path.join(os.homedir(), 'Library', 'Messages', 'chat.db'), {
	readonly: true
});
const env = process.env;
const url = env.PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const h = {
	apikey: env.SUPABASE_SERVICE_ROLE_KEY,
	Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
	'Content-Type': 'application/json'
};

// Pull every message in the workspace with its source_rowid + current body.
const res = await fetch(
	`${url}/rest/v1/chat_messages?select=id,source_rowid,body&workspace_id=eq.${workspace_id}&limit=2000`,
	{ headers: h }
);
if (!res.ok) {
	console.error(`fetch chat_messages: ${res.status} ${await res.text()}`);
	process.exit(1);
}
const rows = await res.json();
console.log(`scanning ${rows.length} rows in workspace ${wsArg}…`);

const stmt = CHAT_DB.prepare(
	'SELECT text, attributedBody FROM message WHERE ROWID = ? LIMIT 1'
);

let updated = 0;
let unchanged = 0;
let nofix = 0;
let skipped = 0;
for (const r of rows) {
	const dbRow = stmt.get(Number(r.source_rowid));
	if (!dbRow) {
		skipped++;
		continue;
	}
	const fresh = extractText(dbRow);
	if (!fresh) {
		nofix++;
		continue;
	}
	if (fresh === r.body) {
		unchanged++;
		continue;
	}
	if (dryRun) {
		console.log(
			`  [dry] ${r.id.slice(0, 8)} rowid=${r.source_rowid}\n    old: ${(r.body || '').slice(0, 90)}\n    new: ${fresh.slice(0, 90)}`
		);
	} else {
		const upd = await fetch(`${url}/rest/v1/chat_messages?id=eq.${r.id}`, {
			method: 'PATCH',
			headers: { ...h, Prefer: 'return=minimal' },
			body: JSON.stringify({ body: fresh })
		});
		if (!upd.ok) {
			console.error(`PATCH ${r.id} failed: ${upd.status} ${await upd.text()}`);
			continue;
		}
	}
	updated++;
}

console.log(
	`\ndone: updated=${updated} unchanged=${unchanged} no_extraction=${nofix} skipped=${skipped}${dryRun ? ' (dry-run)' : ''}`
);
