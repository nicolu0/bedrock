// Connect a Gmail mailbox to the agent + register an INBOX watch — a CLI
// replacement for the (broken) webapp OAuth flow. Mirrors
// src/routes/api/gmail/callback/+server.js exactly: gmail.readonly + gmail.send
// scopes, token exchange, gmail_connections upsert, users/watch on INBOX via
// GMAIL_PUBSUB_TOPIC.
//
// Uses a localhost loopback redirect so it never touches the prod callback.
// ONE-TIME setup: add  http://localhost:8976/oauth2callback  to the OAuth
// client's Authorized redirect URIs (Google Cloud Console → Credentials → the
// client matching GOOGLE_CLIENT_ID).
//
//   node scripts/gmail-connect.mjs                       # connects andrew@usebedrock.co
//   node scripts/gmail-connect.mjs --email x@y.com --template 21andrewch@gmail.com

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(HERE, '../../.env');
const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

function arg(name, def) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const TARGET_EMAIL = (arg('email', 'andrew@usebedrock.co')).toLowerCase();
const TEMPLATE_EMAIL = (arg('template', '21andrewch@gmail.com')).toLowerCase();

// ── env ──
const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (!m) continue;
	let v = m[2].trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
	env[m[1]] = v;
}
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_PUBSUB_TOPIC } = env;
const SUPA = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
for (const [k, v] of Object.entries({ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_PUBSUB_TOPIC, SUPA, KEY }))
	if (!v) { console.error(`missing env: ${k}`); process.exit(1); }

const sh = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };
const supaGet = (q) => fetch(`${SUPA}/rest/v1/${q}`, { headers: sh }).then((r) => r.json());

// ── consent url ──
const consentUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
	client_id: GOOGLE_CLIENT_ID,
	redirect_uri: REDIRECT_URI,
	response_type: 'code',
	scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
	access_type: 'offline',
	prompt: 'consent',
	login_hint: TARGET_EMAIL,
	state: 'cli'
});

const tmpl = (await supaGet(`gmail_connections?email=eq.${encodeURIComponent(TEMPLATE_EMAIL)}&select=user_id,workspace_id,mode`))[0];
if (!tmpl) { console.error(`no template connection for ${TEMPLATE_EMAIL} — pass --template <connected email>`); process.exit(1); }
console.log(`template (${TEMPLATE_EMAIL}): user_id=${tmpl.user_id} workspace_id=${tmpl.workspace_id} mode=${tmpl.mode}`);

async function exchangeCode(code) {
	const r = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' })
	});
	if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
	return r.json();
}
const gmail = (p, tok, opts = {}) => fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${p}`, { ...opts, headers: { Authorization: `Bearer ${tok}`, ...(opts.headers || {}) } });

async function finish(code) {
	const tok = await exchangeCode(code);
	const profile = await gmail('profile', tok.access_token).then((r) => r.json());
	const email = String(profile.emailAddress || '').toLowerCase();
	console.log(`authorized as: ${email}`);
	if (email !== TARGET_EMAIL) console.log(`⚠️  expected ${TARGET_EMAIL} — got ${email}. Saving anyway as ${email}.`);

	const payload = {
		user_id: tmpl.user_id, workspace_id: tmpl.workspace_id, mode: tmpl.mode,
		email, access_token: tok.access_token, refresh_token: tok.refresh_token ?? null,
		expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(), updated_at: new Date().toISOString()
	};
	const existing = (await supaGet(`gmail_connections?email=eq.${encodeURIComponent(email)}&select=id,refresh_token`))[0];
	if (existing && !payload.refresh_token) payload.refresh_token = existing.refresh_token;
	let connId;
	if (existing) {
		await fetch(`${SUPA}/rest/v1/gmail_connections?id=eq.${existing.id}`, { method: 'PATCH', headers: sh, body: JSON.stringify(payload) });
		connId = existing.id;
	} else {
		const ins = await fetch(`${SUPA}/rest/v1/gmail_connections`, { method: 'POST', headers: { ...sh, Prefer: 'return=representation' }, body: JSON.stringify(payload) }).then((r) => r.json());
		connId = ins[0]?.id;
	}
	console.log(`✓ gmail_connections ${existing ? 'updated' : 'created'}: ${connId}`);

	// register the INBOX watch
	const watch = await gmail('watch', tok.access_token, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ topicName: GMAIL_PUBSUB_TOPIC, labelIds: ['INBOX'], labelFilterAction: 'include' })
	}).then((r) => r.json());
	if (watch.error) throw new Error(`watch: ${JSON.stringify(watch.error)}`);
	await fetch(`${SUPA}/rest/v1/gmail_connections?id=eq.${connId}`, {
		method: 'PATCH', headers: sh,
		body: JSON.stringify({ last_history_id: watch.historyId ?? profile.historyId ?? null, watch_expires_at: watch.expiration ? new Date(Number(watch.expiration)).toISOString() : null, updated_at: new Date().toISOString() })
	});
	console.log(`✓ watch active — historyId=${watch.historyId} expires=${watch.expiration ? new Date(Number(watch.expiration)).toISOString() : '?'}`);
}

const server = http.createServer(async (req, res) => {
	const u = new URL(req.url, REDIRECT_URI);
	if (!u.pathname.startsWith('/oauth2callback')) { res.writeHead(404).end(); return; }
	const code = u.searchParams.get('code');
	const err = u.searchParams.get('error');
	if (err) { res.writeHead(400).end(`OAuth error: ${err}`); console.error('OAuth error:', err); server.close(); process.exit(1); }
	try {
		await finish(code);
		res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>✓ Connected. Watch active. You can close this tab.</h2>');
		console.log('\n✅ done.');
	} catch (e) {
		res.writeHead(500).end(`Failed: ${e.message}`);
		console.error('\n❌', e.message);
	} finally {
		server.close();
		setTimeout(() => process.exit(0), 200);
	}
});
server.listen(PORT, () => {
	console.log(`\nlistening on ${REDIRECT_URI}`);
	console.log(`\nOpen this URL and authorize as ${TARGET_EMAIL}:\n\n${consentUrl}\n`);
	exec(`open "${consentUrl}"`);
});
