// Conversation history for incoming_user_message turns.
//
// Each PM turn used to be handled cold — only the new message + a recent-sends
// list. This builds the prior conversation as OpenAI prior-turn messages so the
// model can see what was said and what it already did (the prerequisite for
// recognizing a follow-up answer it asked for last turn).
//
// Source of truth is the sessionizer's open-session transcript (both directions
// are captured there — the poller re-ingests our own sends). We read the recent
// DB window, map senders to roles, and drop the just-arrived message(s)
// (the poller sessionizes each row BEFORE the turn, so the current message is
// already in `recent` — it's the live user content, not history).
//
// Best-effort by design: any failure → []. Sessionization is prod-only, so the
// test workspace and the eval suite get no live session — evals inject a
// transcript via ctx.history instead.

import * as sessionizer from './sessionizer.mjs';

// How many prior messages to surface. The sessionizer cache already caps its
// `recent` window (RECENT_MSG_COUNT); this is a second ceiling in case a future
// source returns more.
const MAX_HISTORY = 10;

export async function buildSessionHistory(event, ctx) {
	// Eval mode: never touch Supabase (the harness only mocks issues_v2; a real
	// sessionizer read would hit the live DB). Scenarios inject prior turns as
	// ctx.history in OpenAI message shape.
	if (process.env.BEDROCK_EVAL_MODE === '1') {
		return Array.isArray(ctx?.history) ? ctx.history : [];
	}

	const chat_guid = event?.payload?.chat_guid ?? ctx?.chat_guid;
	if (!chat_guid) return [];

	// The live user content this turn — one message, or a settled burst. The
	// poller passes the individual burst lines as ctx.liveBodies (the turn's text
	// is them joined), so each is dropped from the history tail rather than the
	// joined blob (which never matches a single stored row).
	const currentText = String(event?.payload?.text ?? ctx?.text ?? '').trim();
	const liveBodies =
		Array.isArray(ctx?.liveBodies) && ctx.liveBodies.length
			? ctx.liveBodies.map((b) => String(b ?? '').trim()).filter(Boolean)
			: currentText
				? [currentText]
				: [];

	try {
		// Read the authoritative DB transcript, not getOpenSession().recent — that
		// cache can drift and silently drop a prior turn (e.g. a PM reply that's in
		// chat_messages but missing from the cached window).
		const recent = await sessionizer.getRecentMessagesForChat(chat_guid, MAX_HISTORY);
		if (!Array.isArray(recent) || recent.length === 0) return [];

		// Multiset of live bodies still pending a drop — one decrement per match so
		// the just-arrived message(s) ride in this turn's user content only, while a
		// genuine earlier repeat of the same text survives in history.
		const dropCounts = new Map();
		for (const b of liveBodies) dropCounts.set(b, (dropCounts.get(b) ?? 0) + 1);

		const messages = [];
		for (const m of recent) {
			const body = String(m?.body ?? '').trim();
			if (!body) continue;
			const role = m?.sender === 'agent' ? 'assistant' : 'user';
			if (role === 'user' && (dropCounts.get(body) ?? 0) > 0) {
				dropCounts.set(body, dropCounts.get(body) - 1);
				continue;
			}
			messages.push({ role, content: body });
		}

		return messages.slice(-MAX_HISTORY);
	} catch {
		// History is a nicety, never a blocker. Degrade to today's behavior.
		return [];
	}
}
