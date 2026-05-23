// Per-handle conversation log + canned opener for the demo flow.
//
// Lives outside the orchestrator so the orchestrator stays event-agnostic.
// The router wires this in as the demo_message event's preCheck and commit
// hooks. State stays in-process for now (lost on restart); the layered-memory
// PR will move conversation history to Supabase.

const conversations = new Map(); // handle → [{ role, content }]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OPENER_MESSAGES = [
	"hey, i'm bedrock. i handle work orders for property managers, all over text. no logging into your pms, no chasing tenants or vendors. that's my job.",
	'want to run through an example together?'
];
const OPENER_TYPING_DELAY_MS = 600;
const OPENER_BETWEEN_MS = 700;

export function getConversation(handle) {
	return conversations.get(handle) ?? [];
}

export function resetConversation(handle) {
	conversations.delete(handle);
}

// Eval-only: seed a conversation history without replaying turns. Lets
// scenarios start mid-flow (e.g. "user is in setup stage, has named property").
export function _setConversationForTest(handle, messages) {
	conversations.set(handle, [...messages]);
}

// Append the new user message to the conversation log AND return the
// prior-history messages array (already-spoken turns) for the orchestrator
// to splice into the working messages.
export function ingestDemoUserMessage(handle, text) {
	const existing = conversations.get(handle) ?? [];
	const priorHistory = existing.map(({ role, content }) => ({ role, content }));
	existing.push({ role: 'user', content: text });
	conversations.set(handle, existing);
	return priorHistory;
}

// First turn for this handle? Fire canned opener, skip the LLM. Returns a
// turn-result-shaped object if it short-circuited, or null if the orchestrator
// should proceed normally.
export async function demoPreCheck(ctx) {
	const handle = ctx.handle;
	const existing = conversations.get(handle) ?? [];
	if (existing.length > 0) return null;

	if (ctx.onEvent) await ctx.onEvent({ type: 'read' });
	for (let i = 0; i < OPENER_MESSAGES.length; i++) {
		if (ctx.onEvent) await ctx.onEvent({ type: 'typing' });
		await sleep(OPENER_TYPING_DELAY_MS);
		if (ctx.outbox) ctx.outbox.push(OPENER_MESSAGES[i]);
		if (ctx.onEvent) await ctx.onEvent({ type: 'message', content: OPENER_MESSAGES[i] });
		if (i < OPENER_MESSAGES.length - 1) await sleep(OPENER_BETWEEN_MS);
	}

	// Persist this user turn + canned assistant response.
	existing.push({ role: 'user', content: ctx.text });
	existing.push({ role: 'assistant', content: OPENER_MESSAGES.join('\n') });
	conversations.set(handle, existing);

	return { messages: [...OPENER_MESSAGES], toolCalls: [] };
}

// Post-loop commit hook: persist the assistant's emitted bubbles as the next
// assistant turn in history (joined into one assistant message).
export async function demoCommit(ctx) {
	const handle = ctx.handle;
	const finalText = (ctx.outbox ?? []).join('\n');
	if (!finalText) return;
	const history = conversations.get(handle) ?? [];
	history.push({ role: 'assistant', content: finalText });
	conversations.set(handle, history);
}
