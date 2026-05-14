// F1 skill — new work order arrives in Supabase, draft a 1–2 bubble ping to
// the property manager's groupchat.
//
// Strict slot-fill template — no creativity, no owner branching, no fallback
// phrasings. Mini model is fine because the prompt is rigid. Always drafts
// (sendMode='draft' set by the issue poller) — never live send.

import { sendText } from '../tools/send_text.mjs';

const F1_TASK_PROMPT = `# Task: draft a new-work-order ping

A new work order just arrived. Send the property manager 1 or 2 iMessages via the send_text tool, then STOP.

## How many messages

- If the work order has a recommended vendor: send EXACTLY 2 messages.
- If the work order has NO recommended vendor: send EXACTLY 1 message. Do NOT call send_text again after the first call. Do NOT ask any follow-up question. Just stop.

## The messages

Message 1 (always): "Unit {unit} at {property} has {one-sentence issue summary}."
Message 2 (only if vendor): "Should we send {vendor}?"

## Field rules

- {one-sentence issue summary}: one short sentence. ONE. No periods in the middle. No "and" connecting multiple problems. Pick the most important detail and drop the rest. Keep it under 15 words.
- {unit}: from the work order. If unit is missing, drop the "Unit {unit} at " prefix entirely and write "{property} has {summary}."
- {vendor}: exactly as named in the work order. First name only for individuals (Yonic, Abraham, Mario). Full name for companies (LA Hydro Jet, Cross Appliance Inc).
- Urgent issues: prepend "URGENT: " to Message 1. Otherwise no urgency label.

## Hard rules

- After the appropriate send_text call(s), STOP. Do not call any tool again. Do not produce plain text content. Return.
- One send_text per message — never put both messages in a single call.
- No greetings ("Hey", "Hi"), no signoffs, no emoji, no markdown.
- Never mention owners or owner approval.
- Never add filler ("Let me know", "Hope that helps").
- Never emit "{vendor}", "Should we send ?", or unfilled placeholder text.
- Never invent facts that aren't in the work order.

## Examples

Standard (unit + vendor present):
  Input has: Property=829 Ocean Park, Unit=1, Title=leaky faucet, Vendor=Yonic
  Send: "Unit 1 at 829 Ocean Park has a leaky faucet."
  Send: "Should we send Yonic?"

Unit missing (vendor present) — drop the "Unit X at" prefix:
  Input has: Property=Lincoln Lobby, NO Unit, Title=front door buzzer broken, Vendor=Abraham
  Send: "Lincoln Lobby has a broken front door buzzer."
  Send: "Should we send Abraham?"

Vendor missing (unit present) — send only message 1, then STOP:
  Input has: Property=Hub Champaign, Unit=701, Title=wifi down, NO Vendor
  Send: "Unit 701 at Hub Champaign has wifi down."
  [STOP — no second message, no further tool calls]

Urgent:
  Input has urgent=true. Prepend "URGENT: " to message 1.`;

function formatIssue(issue) {
	const lines = ['New work order:'];
	if (issue.property?.name) lines.push(`Property: ${issue.property.name}`);
	if (issue.unit?.name) lines.push(`Unit: ${issue.unit.name}`);
	if (issue.name) lines.push(`Title: ${issue.name}`);
	if (issue.description) lines.push(`Description: ${issue.description}`);
	if (issue.tenant?.name) lines.push(`Tenant: ${issue.tenant.name}`);
	if (issue.urgent) lines.push('Urgent: yes');
	if (issue.vendor?.name) lines.push(`Recommended vendor: ${issue.vendor.name}`);
	else lines.push('Recommended vendor: (none — skip Message 2)');
	return lines.join('\n');
}

export const f1Skill = {
	name: 'f1',
	model: process.env.WORK_ORDERS_MODEL || 'gpt-4.1-mini',
	maxIterations: 3,
	maxTokens: 300,
	tools: [sendText],
	taskPrompt: F1_TASK_PROMPT,
	buildContext(ctx) {
		if (!ctx.issue) throw new Error('f1 skill: ctx.issue required');
		return [{ role: 'user', content: formatIssue(ctx.issue) }];
	}
};
