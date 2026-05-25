// Work-hours window for scheduled ("Send later") drafts.
//
// One global window in the server's LOCAL timezone — the Mac mini runs in the
// PM's timezone, so local-time math (getDay/getHours/setHours) also gives us
// DST correctness for free, no tz library. If a second customer ever lands in
// a different timezone this becomes per-workspace; deferred until then.
//
// Window: 7am–7pm, Monday–Friday. A work order that arrives outside this
// window gets hold_until = the next window open. Inside the window there's no
// hold. Urgent issues bypass holds entirely (decided at the call site).

const START_HOUR = 7; // 7am, inclusive
const END_HOUR = 19; // 7pm, exclusive
const WORK_DAYS = new Set([1, 2, 3, 4, 5]); // Mon–Fri (Date.getDay: 0=Sun, 6=Sat)

export function isWorkHours(now = new Date()) {
	if (!WORK_DAYS.has(now.getDay())) return false;
	const h = now.getHours();
	return h >= START_HOUR && h < END_HOUR;
}

// The next moment the window opens, as an ISO string.
//   - before 7am on a weekday  → 7am today
//   - after 7pm, or any weekend → 7am on the next weekday
// Returns null if we're currently inside the window (caller shouldn't hold).
export function nextSendTime(now = new Date()) {
	if (isWorkHours(now)) return null;

	const t = new Date(now);
	// Before the window opens, on a weekday → 7am the same day.
	if (WORK_DAYS.has(t.getDay()) && t.getHours() < START_HOUR) {
		t.setHours(START_HOUR, 0, 0, 0);
		return t.toISOString();
	}
	// Otherwise roll forward to 7am on the next weekday.
	do {
		t.setDate(t.getDate() + 1);
	} while (!WORK_DAYS.has(t.getDay()));
	t.setHours(START_HOUR, 0, 0, 0);
	return t.toISOString();
}
