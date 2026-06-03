// Scratch: backfill AppFolio WO emails that pubsub-hook dropped (From-rewrite bug).
// Lists subject:WO mail in the connected mailbox, routes by group alias, and POSTs
// each to the intake-agent edge fn (idempotent — dedups on appfolio_srn).
//   node scripts/_backfill-wo.mjs            # LAPM only, real run
//   node scripts/_backfill-wo.mjs --dry      # print plan, no writes
//   node scripts/_backfill-wo.mjs --all      # include Green Oak too
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(HERE, '../../.env');
const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (!m) continue;
	let v = m[2].trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
	env[m[1]] = v;
}
const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');
const SUPA = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
const TARGET = 'andrew@usebedrock.co';

const WORKSPACE_BY_ALIAS = {
	'lapm@usebedrock.co': '2e4373a0-40b8-42c2-a873-b08c99dbf76a',
	'greenoakpropertymanagement@usebedrock.co': '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7'
};
const LAPM = '2e4373a0-40b8-42c2-a873-b08c99dbf76a';
const APPFOLIO = 'donotreply@appfolio.com';

const sb = (p, opts = {}) =>
	fetch(`${SUPA}/rest/v1/${p}`, {
		...opts,
		headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
	});
const gmail = (p, tok) =>
	fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${p}`, { headers: { Authorization: `Bearer ${tok}` } });

const b64url = (s) => {
	const n = s.replace(/-/g, '+').replace(/_/g, '/');
	return Buffer.from(n + '='.repeat((4 - (n.length % 4)) % 4), 'base64').toString('utf-8');
};
const findPart = (payload, mime) => {
	if (!payload) return null;
	if (payload.mimeType === mime && payload.body?.data) return payload.body.data;
	for (const part of payload.parts || []) {
		const f = findPart(part, mime);
		if (f) return f;
	}
	return null;
};
const stripHtml = (s) =>
	s.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
const plainBody = (payload) => {
	const p = findPart(payload, 'text/plain');
	if (p) return b64url(p);
	const h = findPart(payload, 'text/html');
	return h ? stripHtml(b64url(h)) : '';
};
const hdr = (headers, name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const parseSubject = (subject) => {
	const parts = (subject || '').split(' - ');
	const srn = (parts[0] || '').match(/WO\s*#([\w-]+)/i)?.[1] ?? null;
	let prop = null;
	for (let i = 1; i < parts.length; i++) if (/^\d+$/.test(parts[i].trim())) { prop = parts[i].trim(); break; }
	return { srn, prop };
};

async function getToken() {
	const rows = await (await sb(`gmail_connections?email=eq.${encodeURIComponent(TARGET)}&select=access_token,refresh_token,expires_at`)).json();
	const c = rows[0];
	if (new Date(c.expires_at).getTime() - Date.now() >= 120000) return c.access_token;
	const r = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: c.refresh_token, grant_type: 'refresh_token' })
	});
	if (!r.ok) throw new Error('refresh failed: ' + (await r.text()));
	return (await r.json()).access_token;
}

const main = async () => {
	const tok = await getToken();
	let ids = [];
	let pageToken = '';
	do {
		const j = await (await gmail(`messages?q=${encodeURIComponent('subject:WO')}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`, tok)).json();
		ids.push(...(j.messages || []).map((m) => m.id));
		pageToken = j.nextPageToken || '';
	} while (pageToken);
	console.log(`found ${ids.length} subject:WO messages`);

	const tally = { created: 0, duplicate: 0, skipped: 0, error: 0, byWs: {} };
	for (const id of ids) {
		const m = await (await gmail(`messages/${id}?format=full`, tok)).json();
		const headers = m.payload?.headers || [];
		const from = hdr(headers, 'from');
		const replyTo = hdr(headers, 'reply-to');
		const to = hdr(headers, 'to');
		const subject = hdr(headers, 'subject');
		const hay = [from, to, hdr(headers, 'delivered-to')].join(' ').toLowerCase();
		if (!from.includes(APPFOLIO) && !replyTo.includes(APPFOLIO)) { tally.skipped++; continue; }
		const wsEntry = Object.entries(WORKSPACE_BY_ALIAS).find(([a]) => hay.includes(a));
		const workspaceId = wsEntry?.[1] ?? null;
		if (!workspaceId) { tally.skipped++; continue; }
		if (!ALL && workspaceId !== LAPM) { tally.skipped++; continue; }
		const { srn, prop } = parseSubject(subject);
		if (!srn) { tally.skipped++; continue; }
		const body = plainBody(m.payload);
		const label = `${srn} ws=${workspaceId === LAPM ? 'LAPM' : 'GreenOak'} prop=${prop ?? '-'}`;
		if (DRY) { console.log('  DRY would ingest', label, '|', subject.slice(0, 40)); tally.byWs[workspaceId] = (tally.byWs[workspaceId] || 0) + 1; continue; }
		const res = await fetch(`${SUPA}/functions/v1/intake-agent`, {
			method: 'POST',
			headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ workspaceId, serviceRequestNumber: srn, appfolioPropertyId: prop, subject, body, gmailMessageId: id })
		});
		const out = await res.json().catch(() => ({}));
		if (!res.ok || out.ok === false) { console.log('  ERR', label, res.status, JSON.stringify(out)); tally.error++; }
		else if (out.skipped === 'duplicate') { tally.duplicate++; }
		else { console.log('  CREATED', label, '->', out.issueId); tally.created++; }
	}
	console.log('DONE', JSON.stringify(tally));
};
main().catch((e) => { console.error(e); process.exit(1); });
