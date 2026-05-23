// process_wo skill — new work order arrives in Supabase, draft a 1–2 bubble
// ping to the property manager's groupchat.
//
// Strict slot-fill template — no creativity, no owner branching, no fallback
// phrasings. Mini model is fine because the prompt is rigid. Always drafts
// (sendMode='draft' set by the issue poller) — never live send.

import { sendText } from '../tools/send_text.mjs';

const PROCESS_WO_TASK_PROMPT = `# Task: draft a new-work-order ping

A new work order just arrived. Send the property manager 1 or 2 iMessages via the send_text tool, then STOP.

## How many messages

- If the work order has a recommended vendor: send EXACTLY 2 messages.
- If the work order has NO recommended vendor: send EXACTLY 1 message. Do NOT call send_text again after the first call. Do NOT ask any follow-up question. Just stop.

## The messages

Message 1 (always): one short, natural-sounding English sentence that says which unit/property and what the issue is. Write it like a person texting another person — full prose, real grammar, no colons, no em dashes, no headline shorthand.
Message 2 (only if vendor): "Should we send {vendor}?"

## Field rules

- Message 1 must convey three things in one short sentence: the unit (if present), the property, and the issue. Beyond that, write whatever flows naturally. A few shapes that work:
  - "Unit {unit} at {property} has {a/an/no ...}." → "Unit 701 at Hub Champaign has a leaky faucet." / "Unit 701 at Hub Champaign has no wifi."
  - "Unit {unit} at {property}'s {thing} is {state}." → "Unit 701 at Hub Champaign's wifi is down." / "Unit 5 at Mariposa's dryer isn't working."
  - "The {thing} at unit {unit}, {property} is {state}." → "The dryer at Unit 5, Mariposa isn't working."
  Pick the one that reads most naturally for the given title. Rewrite the title's words freely to make the sentence flow — don't paste the raw title in if it makes the grammar awkward.
- Forbidden in Message 1: colons, em dashes, semicolons, sentence fragments, headline style ("Unit 701: wifi down"), or ungrammatical "has {bare phrase}" constructions ("has dryer not working", "has wifi down", "has front door buzzer broken"). If "has X" would be awkward, restructure the sentence.
- Length: one sentence, under 15 words. No "and" connecting multiple problems — pick the most important detail and drop the rest.
- Unit handling: if unit is missing, drop the "Unit {unit} at " prefix and lead with the property ("Lincoln Lobby has a broken front door buzzer.").
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

Vendor missing (unit present) — send only message 1, then STOP. Rewrite the title into a natural sentence:
  Input has: Property=Hub Champaign, Unit=701, Title=wifi down, NO Vendor
  Send: "Unit 701 at Hub Champaign has no wifi."  (or "Unit 701 at Hub Champaign's wifi is down.")
  [STOP — no second message, no further tool calls]

Awkward title — rephrase into a real sentence, no colons:
  Input has: Property=Mariposa, Unit=5, Title=dryer not working, Vendor=Mario
  Send: "Unit 5 at Mariposa's dryer isn't working."  (or "Unit 5 at Mariposa has a broken dryer.")
  Send: "Should we send Mario?"

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

export const processWoSkill = {
	name: 'process_wo',
	model: process.env.WORK_ORDERS_MODEL || 'gpt-5.4-2026-03-05',
	maxIterations: 3,
	maxTokens: 300,
	tools: [sendText],
	// Transitional: process_wo prompt occasionally drifts and emits a draft as plain
	// content instead of a send_text call. Keep the orchestrator's fallback
	// as a safety net until the prompt is tightened. See orchestrator.mjs.
	allowPlainContentSend: true,
	taskPrompt: PROCESS_WO_TASK_PROMPT,
	buildContext(ctx) {
		if (!ctx.issue) throw new Error('process_wo skill: ctx.issue required');
		return [{ role: 'user', content: formatIssue(ctx.issue) }];
	}
};
