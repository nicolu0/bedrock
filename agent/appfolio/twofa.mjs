// AppFolio 2FA code reader. AppFolio's "Unified Account" login (Keycloak) texts a
// 6-digit verification code on every login. Those SMS land in this Mac mini's
// Messages, so the send runner can read the latest one straight from chat.db and
// complete login fully headless — no human, no window.
//
// We reuse the chat.db decode helpers from the chat poller (pure, no side
// effects on import). Codes are matched by CONTENT ("…verify your AppFolio
// account"), so it works regardless of which shortcode AppFolio texts from.

import { getDb, extractText, appleDateToISO } from '../triggers/chat-poller.mjs';

// e.g. "107752 Use this code to verify your AppFolio account. This code will expire in 10 minutes."
const CODE_RE = /\b(\d{6})\b[\s\S]{0,40}verify your AppFolio account/i;

// Most recent AppFolio 2FA code that arrived at/after `sinceMs` (a JS epoch ms;
// pass the moment you submitted the password so a stale code can't be reused).
// Returns { code, tsMs } or null if no fresh code has landed yet.
export function readLatestAppfolioCode(sinceMs = 0, { skewMs = 8000 } = {}) {
	let rows;
	try {
		rows = getDb()
			.prepare(
				`SELECT m.ROWID AS rowid, m.text, m.attributedBody, m.date
				 FROM message m
				 WHERE m.is_from_me = 0
				 ORDER BY m.ROWID DESC
				 LIMIT 80`
			)
			.all();
	} catch {
		return null;
	}
	for (const r of rows) {
		const text = extractText(r) || '';
		const mm = text.match(CODE_RE);
		if (!mm) continue;
		// First match scanning newest-first = the latest code. If it predates our
		// submit, no fresh code has arrived yet — wait and retry.
		const iso = appleDateToISO(r.date);
		const tsMs = iso ? Date.parse(iso) : 0;
		return tsMs >= sinceMs - skewMs ? { code: mm[1], tsMs } : null;
	}
	return null;
}
