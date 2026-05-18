// send_text — the only tool that emits a customer-visible message.
//
// Behavior is gated by `ctx.sendMode`:
//   'live'   — emit via ctx.onEvent({ type: 'message', ... }). The transport
//              (server.mjs) handles typing-dot dwell + dylib send. Only used
//              for the demo skill talking 1:1 to unknown handles.
//   'draft'  — append to ctx.drafts. Used by F1, F2, and anything routed to
//              the drafts UI for human review.
//
// Safety: in 'live' mode, if ctx.isPmHandle is true, refuse with an error.
// This is the belt-and-suspenders against a future caller mistakenly routing
// a PM handle (Jose's numbers) through the live path. Pollers set
// ctx.isPmHandle when the handle matches workspaces.mjs pm_handles.

export const sendText = {
	name: 'send_text',
	description:
		'Send one customer-visible message. Each call becomes its own message bubble — call multiple times for multiple separate messages back to back. Never include newlines or multiple thoughts inside a single call; split into separate calls instead.',
	parameters: {
		type: 'object',
		properties: {
			content: { type: 'string', description: 'The text body for this one message.' }
		},
		required: ['content']
	},
	async run({ content }, ctx) {
		const text = String(content ?? '').trim();
		if (!text) return { ok: true, skipped: 'empty' };

		// Defensive: drop obvious placeholder leakage (F1 strict-template guard).
		// Cheap to apply universally — placeholders are never valid output.
		if (/\{[a-z_]+\}/i.test(text)) return { ok: true, skipped: 'unfilled placeholder' };
		if (/Should we send\s*\??$/i.test(text)) return { ok: true, skipped: 'empty vendor slot' };

		if (ctx.sendMode === 'draft') {
			ctx.drafts = ctx.drafts ?? [];
			ctx.drafts.push({ body: text });
			// assistantContent: the orchestrator concatenates this into the
			// assistant message between iterations so the model reads its own
			// speech as plain text on the next loop. Generic mechanism — any
			// tool can opt in.
			return { ok: true, assistantContent: text };
		}

		if (ctx.sendMode === 'live') {
			if (ctx.isPmHandle) {
				throw new Error(
					`send_text refused: safety guard — cannot live-send to a known PM handle (${ctx.handle ?? 'unknown'}). All PM-handle paths must use sendMode='draft'.`
				);
			}
			// Split on newlines defensively — the prompt forbids them but if the
			// model slips, treat each segment as its own bubble.
			const parts = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
			for (const part of parts) {
				if (ctx.outbox) ctx.outbox.push(part);
				if (ctx.onEvent) await ctx.onEvent({ type: 'message', content: part });
			}
			return { ok: true, assistantContent: parts.join('\n') };
		}

		throw new Error(`send_text: ctx.sendMode required ('live' | 'draft'), got ${JSON.stringify(ctx.sendMode)}`);
	}
};
