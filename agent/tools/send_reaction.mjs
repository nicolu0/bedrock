// send_reaction — add a tapback (heart/thumbs/laugh/!!/?) on the user's
// most recent message. Requires ctx.react (bound to the incoming message GUID
// by the transport). Use sparingly — only when a reaction is natural.

export const sendReaction = {
	name: 'send_reaction',
	description:
		"Add a tapback (heart, thumbs up/down, ha-ha, !!, ?) on the user's most recent message. Use sparingly — only when a reaction would feel natural in real iMessage. Examples: love-react when they share something exciting; laugh-react at a joke; emphasize-react to flag importance. Avoid reacting to every message.",
	parameters: {
		type: 'object',
		properties: {
			reaction: {
				type: 'string',
				enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'],
				description:
					'Tapback type. love=heart, like=thumbs up, dislike=thumbs down, laugh=ha-ha, emphasize=!!, question=?'
			}
		},
		required: ['reaction']
	},
	async run({ reaction }, ctx) {
		if (typeof ctx.react !== 'function') {
			return { ok: false, error: 'react capability not available in this context' };
		}
		const r = await ctx.react(reaction);
		return { ok: r?.ok !== false, error: r?.error };
	}
};
