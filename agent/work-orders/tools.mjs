// Work-orders subagent tools. v1 has only send_text.
//
// send_text in this mode does NOT call the dylib. It appends to ctx.drafts —
// an accumulator the caller (issue poller) reads after the turn to build the
// draft bundle. The Send button on the drafts UI is what actually fires the
// dylib later, replaying the bundle in order.

export const TOOL_DEFS = [
	{
		type: 'function',
		function: {
			name: 'send_text',
			description:
				'Send one iMessage to the property manager. Each call becomes its own message bubble. Call twice for two messages.',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'The text body for this one message.' }
				},
				required: ['content']
			}
		}
	}
];

export async function executeTool(name, args, ctx) {
	switch (name) {
		case 'send_text': {
			const text = String(args?.content ?? '').trim();
			if (!text) return { ok: true, skipped: 'empty' };
			// Defensive: drop obvious placeholder leakage. The prompt forbids these
			// but if the model slips up, an empty-slot message is worse than nothing.
			if (/\{[a-z_]+\}/i.test(text)) return { ok: true, skipped: 'unfilled placeholder' };
			if (/Should we send\s*\??$/i.test(text)) return { ok: true, skipped: 'empty vendor' };
			ctx.drafts = ctx.drafts ?? [];
			ctx.drafts.push({ body: text });
			return { ok: true };
		}
		default:
			return { error: `unknown tool: ${name}` };
	}
}
