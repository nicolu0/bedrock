// acknowledge — live ack into the current chat. Use BEFORE any draft tools
// to let the PM know the message landed and the agent is acting on it.
//
// Action space is intentionally tiny: the phrase parameter is an enum, so
// the model can't write anything beyond the approved phrases. This makes it
// safe to live-send into a customer-visible chat without trust + evals in
// place — there's no way for the model to say something off-script.
//
// Implementation parity with send_text: emits ctx.onEvent({type:'message'})
// and pushes to ctx.outbox. The transport (server.mjs) handles typing-dot
// dwell + dylib send.

const PHRASES = ['got it', 'on it', 'okay', 'thanks', 'noted'];

export const acknowledge = {
	name: 'acknowledge',
	description:
		"Send a short acknowledgment to the current chat indicating you received the PM's message and are working on it. Use this BEFORE calling draft_tenant or draft_vendor for the same turn. Do not use this if you are NOT taking action on the message — only ack when you're about to draft something.",
	parameters: {
		type: 'object',
		properties: {
			phrase: {
				type: 'string',
				enum: PHRASES,
				description: 'The acknowledgment phrase to send.'
			}
		},
		required: ['phrase']
	},
	async run({ phrase }, ctx) {
		if (!PHRASES.includes(phrase)) {
			// Defensive: if the model tries something off-enum (shouldn't be
			// possible with structured outputs, but belt-and-suspenders).
			return { ok: false, error: `phrase must be one of: ${PHRASES.join(', ')}` };
		}
		if (ctx.outbox) ctx.outbox.push(phrase);
		if (ctx.onEvent) await ctx.onEvent({ type: 'message', content: phrase });
		return { ok: true, assistantContent: phrase };
	}
};
