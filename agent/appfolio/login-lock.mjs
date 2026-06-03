// Cross-process AppFolio login lock. Every account's 2FA code is texted from the
// SAME shortcode with identical wording ("…verify your AppFolio account") to this
// one Mac mini, so codes are indistinguishable by sender or content. The only
// safe disambiguation is to allow at most ONE login in flight at a time across
// all per-workspace runner processes: then "the newest code after I submitted my
// password" (twofa.mjs freshness gate) is unambiguously mine.
//
// Implemented as an O_EXCL lockfile in appfolio/ (shared dir → shared across the
// LAPM:9773 and Green Oak:9774 processes). Stale locks (holder crashed) are
// stolen after STALE_MS. The holder flag is per-process so release() never
// deletes another process's lock.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK = path.join(HERE, '.login.lock');
const STALE_MS = 180000; // > the runner's 150s login cap → only a dead holder is stolen
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let held = false;

// Block until the login slot is free (or timeoutMs elapses). Returns true if
// acquired. Safe to call once per login attempt; pair with releaseLoginLock().
export async function acquireLoginLock(meta = {}, { timeoutMs = 240000, pollMs = 2000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			fs.writeFileSync(LOCK, JSON.stringify({ ...meta, ts: Date.now() }), { flag: 'wx' });
			held = true;
			return true;
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
			// Lock exists — steal it if the holder looks dead, else wait.
			let stale = false;
			try {
				const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
				stale = Date.now() - (cur.ts || 0) > STALE_MS;
			} catch {
				stale = true; // unreadable/garbage → treat as abandoned
			}
			if (stale) {
				try { fs.unlinkSync(LOCK); } catch { /* someone else got it */ }
				continue;
			}
			if (Date.now() >= deadline) return false;
			await sleep(pollMs);
		}
	}
}

export function releaseLoginLock() {
	if (!held) return; // never delete a lock this process didn't take
	held = false;
	try { fs.unlinkSync(LOCK); } catch { /* already gone */ }
}

export function holdsLoginLock() {
	return held;
}

// Called once at runner boot. A lock tagged with OUR port can only be a leftover
// from this runner's previous (killed/crashed) incarnation — no login is ever in
// flight at startup — so clear it. Without this, a restart mid-login would block
// the next login for up to STALE_MS. Leaves the OTHER workspace's lock alone (it
// carries a different port), so it can't disrupt a concurrent login there.
export function clearOwnStaleLock(port) {
	try {
		const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
		if (cur && cur.port === port) fs.unlinkSync(LOCK);
	} catch {
		/* no lock, or unreadable — nothing to clear */
	}
}
