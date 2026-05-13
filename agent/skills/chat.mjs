// Chat skill — runs when the PM replies in a mapped groupchat.
//
// Decides whether the reply confirms vendor dispatch on one of the recent
// work orders we texted the PM about. If yes: acknowledge + tenant draft +
// vendor draft. If no: no tool calls (chat poller will tag the chat-log row
// as 'no_match' so we can see it in the dashboard).
//
// v1 keeps the candidate set simple: last 5 groupchat sends within 7 days,
// derived from sent-log.json by bundle_id. The model reads the actual
// message bodies (which include property/unit/vendor names) to correlate.

import { recentSentForChat } from '../work-orders/state/helpers.mjs';
import { acknowledge } from '../tools/acknowledge.mjs';
import { draftTenant } from '../tools/draft_tenant.mjs';
import { draftVendor } from '../tools/draft_vendor.mjs';

const CHAT_TASK_PROMPT = `# Task: handle a property manager's reply in their groupchat

The property manager just replied in a groupchat where you previously texted them about open work orders. Your job is to decide whether their reply is approving vendor dispatch for one of those work orders.

You will receive:
- A numbered list of the most recent work orders you texted them about, each tagged with an issue_id, including the message bodies you sent (which already contain property, unit, and vendor names).
- The PM's new reply text.

How to decide:

- If the reply clearly confirms going ahead with the vendor for ONE of the listed issues (e.g. "yes", "yep", "go ahead", "send him", "okay", or just naming the same vendor):
  1. Call acknowledge with a phrase like 'got it' or 'on it'.
  2. Call draft_tenant with that issue_id.
  3. Call draft_vendor with that issue_id.
  Three tool calls in that order. Use the issue_id EXACTLY as shown — copy it.

- If the reply redirects to a DIFFERENT vendor than the one we suggested ("send Luigi instead"), do NOT draft. v1 doesn't handle vendor swaps yet. Make no tool calls.

- If the reply is a question, ambiguous, off-topic, or could plausibly match more than one issue, make no tool calls. The dashboard will log this as 'no_match' so the human sees it.

- Never invent an issue_id. Use only the ones from the candidate list.

- Do not call acknowledge unless you are ALSO going to call draft_tenant and draft_vendor in the same turn. Acks are for confirming you're taking action, not for chit-chat.`;

function formatRecentBundles(bundles) {
	if (!bundles.length) return '(no recent work orders sent in this chat — nothing to correlate against)';
	const lines = bundles.map((b, i) => {
		const bodies = b.bodies.map((line) => `   ${line}`).join('\n');
		return `${i + 1}. [issue_id: ${b.issue_id}]\n${bodies}`;
	});
	return lines.join('\n\n');
}

export const chatSkill = {
	name: 'chat',
	model: process.env.CHAT_MODEL || 'gpt-5.4-2026-03-05',
	maxIterations: 5,
	tools: [acknowledge, draftTenant, draftVendor],
	taskPrompt: CHAT_TASK_PROMPT,

	async buildContext(ctx) {
		if (!ctx.chat_guid) throw new Error('chat skill: ctx.chat_guid required');
		if (!ctx.text) throw new Error('chat skill: ctx.text required');

		const bundles = await recentSentForChat({ chat_guid: ctx.chat_guid });
		const candidates = formatRecentBundles(bundles);

		return [
			{
				role: 'user',
				content: `Recent work orders you texted them about in this chat:

${candidates}

The PM just replied: "${ctx.text}"

Decide and act per the rules above.`
			}
		];
	}
};
