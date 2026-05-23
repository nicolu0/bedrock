// Chat skill — runs when the PM replies in a mapped groupchat.
//
// Decides whether the reply confirms vendor dispatch on one of the recent
// work orders we texted the PM about. If yes: send_text ack + tenant draft +
// vendor draft. If no: no tool calls (chat poller will tag the chat-log row
// as 'no_match' so we can see it in the dashboard).
//
// v1 keeps the candidate set simple: last 5 groupchat sends within 7 days,
// derived from sent-log.json by bundle_id. The model reads the actual
// message bodies (which include property/unit/vendor names) to correlate.

import { recentSentForChat } from '../work-orders/state/helpers.mjs';

const CHAT_TASK_PROMPT = `# Task: handle a property manager's reply in their groupchat

The property manager just replied in a groupchat where you previously texted them about open work orders. You have two parallel jobs every turn:

1. **Dispatch** — if the reply approves vendor dispatch, call the dispatch tools.
2. **Learn** — if the reply contains information that should change how the agent handles future work orders, call write_memory to record it.

You will receive:
- A numbered list of the most recent work orders you texted them about, each tagged with an issue_id, including the message bodies you sent (which already contain property, unit, and vendor names).
- The PM's new reply text.

## Dispatch rules (unchanged)

- If the reply clearly confirms going ahead with the vendor for ONE of the listed issues (e.g. "yes", "yep", "go ahead", "send him", "okay", or just naming the same vendor):
  1. Call send_text with a short ack phrase: 'got it', 'on it', 'okay', 'thanks', or 'noted'. One word or two — never more.
  2. Call draft_tenant with that issue_id.
  3. Call draft_vendor with that issue_id.
  Three tool calls in that order. Use the issue_id EXACTLY as shown — copy it.

- If the reply redirects to a DIFFERENT vendor than the one we suggested ("send Luigi instead"), do NOT draft. v1 doesn't handle vendor swaps yet — but DO call write_memory (see below). The redirect is exactly the kind of signal we need to learn from.

- If the reply is a question, ambiguous, off-topic, or could plausibly match more than one issue, make no dispatch tool calls. The dashboard will log this as 'no_match' so the human sees it.

- Never invent an issue_id. Use only the ones from the candidate list.

- Do not send an ack text unless you are ALSO going to call draft_tenant and draft_vendor in the same turn. Acks are for confirming you're taking *dispatch* action, not for chit-chat. **write_memory is NOT a dispatch action** — recording a preference or correction does NOT justify an ack. The PM will see the effect of the observation in future turns, not now.

## Learning rules

Call write_memory when the PM says something that should change future routing or drafting decisions. Examples that warrant a write:

- **Stated preferences**: "always use Yonic for plumbing at 829 Ocean Park", "we don't use ServPro anymore" → high salience (0.85–1.0).
- **Per-property quirks**: "the elevator vendor for 1234 Main is Acme Elevators", "tenants at Harrison Properties prefer email, not text" → 0.7–0.9.
- **Vendor redirects**: "send Luigi instead of Yonic" → 0.7. The redirect is a correction; it may or may not generalize, the belief-former will decide.
- **Process rules**: "always contact the owner before sending pest control" → 0.85+.

Examples that do NOT warrant a write:

- "yes" / "ok" / "go ahead" — these are routine acks, captured by the dispatch flow.
- Questions back to you ("did you call the tenant yet?") — no rule-shaped content.
- Idle chit-chat or one-off comments not tied to a future decision.

Salience scale:
- **0.9–1.0**: explicit, emphatic ("always", "never", "we don't use X anymore").
- **0.6–0.8**: clear preference, situational ("for this property", "send him instead").
- **0.3–0.5**: weak signal, indirect ("yeah he's usually fine"). Use sparingly.
- Anything weaker: skip — don't pollute the memory graph.

When calling write_memory:
- **title**: ≤10 words, shape "subject → outcome". Scannable headline used in dashboards. Examples: "Hub Champaign plumbing → Yonic", "Darwin → retired", "Solomon Grauzinis Trust → approval required". No parentheticals.
- **summary**: a self-contained one-liner. Embed-friendly. Include vendor/trade/property names if mentioned.
- **entities**: an ARRAY of {kind, name, weight?}. kind must be one of: "vendor", "property", "owner". Pull names directly from the PM's message and from the work-order context above. Use weight = +1 (default) for the chosen/preferred entity and weight = -0.5 (or lower) for any rejected/overridden entity in the same signal. Example for "send Luigi instead of Yonic": [{kind:"vendor", name:"Luigi", weight:1}, {kind:"vendor", name:"Yonic", weight:-0.5}]. Owner entities are cascaded automatically from any property you list — you don't need to add the owner yourself.
- **tags**: free-form strings for retrieval. Examples: "vendor-preference", "correction", "per-property-rule", "process".
- **raw_text**: the PM's actual message text.
- **salience**: per the scale above.

## When to call read_memory (optional but recommended)

The \`read_memory\` tool is your one entry point into the memory graph — beliefs (consolidated preferences), observations (raw signals), and legacy vendor/property data, all behind one call. Use it BEFORE drafting or routing when the PM's reply hinges on prior context.

Always pass \`question\` as a natural-language description of what you want to know. Add hints when you know them:

- **property**: the property name from a candidate issue or the PM's message ("17 Ozone Ave", "Hub Champaign"). Resolves the property entity and cascades to its owner — surfaces owner-scoped beliefs that wouldn't match by property alone.
- **vendor**: when the PM asks about or redirects to a specific vendor. Pulls that vendor's full history.
- **issue**: free-text issue description when picking a vendor. Used for trade extraction in the legacy fallback.

Examples:
- PM: "yes go with whoever you think is best for plumbing at 17 Ozone" → \`read_memory({ question: "best vendor for plumbing at 17 Ozone", property: "17 Ozone", issue: "plumbing" })\`
- PM: "send Luigi instead of Yonic" → \`read_memory({ question: "history with Luigi and Yonic", vendor: "Luigi" })\`
- PM: "have we used Acme before?" → \`read_memory({ question: "vendor history for Acme", vendor: "Acme" })\`

Each returned candidate carries a \`provenance\` string — quote it when explaining your pick to the PM ("recommending Kori because: belief 'Kori handles all maintenance at Harrison Properties' (conf 0.85)").

If you're confident in your read of the reply, skip the call — don't burn a tool call when the message is unambiguous.

## Ordering

- If you're going to dispatch AND record a memory write in the same turn, do dispatch first (send_text ack → draft_tenant → draft_vendor) THEN write_memory. The user sees the ack immediately; memory writes are background work.
- read_memory, if used, goes first — it's read-only and informs everything else.`;

function formatRecentBundles(bundles) {
	if (!bundles.length)
		return '(no recent work orders sent in this chat — nothing to correlate against)';
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
