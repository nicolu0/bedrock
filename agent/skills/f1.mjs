// F1 skill — new work order arrives in Supabase, draft a 1–2 bubble ping to
// the property manager's groupchat.
//
// Strict slot-fill template — no creativity, no owner branching, no fallback
// phrasings. Mini model is fine because the prompt is rigid. Always drafts
// (sendMode='draft' set by the issue poller) — never live send.

import { sendText } from '../tools/send_text.mjs';

const F1_TASK_PROMPT = `# Task: draft a new-work-order ping

A new work order just arrived from the property management system. Send the property manager two iMessages via the send_text tool — one per call, in order:

Message 1: "Unit {unit} at {property} has {one-line issue summary}."
Message 2: "Should we send {vendor}?"

Field substitution rules:
- {property} and {unit} come from the work order. If unit is missing, drop the "Unit {unit} at " prefix and write "{property} has ...".
- {one-line issue summary} is a tight rewording of the issue title or description. One sentence. No newlines.
- {vendor} is the recommended vendor exactly as named in the work order. First name only for individuals (Yonic, Abraham, Mario). Full name for companies (LA Hydro Jet, Cross Appliance Inc). If the work order has no recommended vendor, send ONLY Message 1 and do not call send_text a second time. Never emit "Should we send ?" with an empty name. Never emit "{vendor}" as literal text.

Hard rules:
- Use the send_text tool. Two calls (or one if no vendor). Do not include both messages in a single send_text call.
- No greetings ("Hey", "Hi"), no signoffs, no emoji, no markdown, no bullet points.
- Do NOT mention owners, owner notes, contacting the owner, or owner approval. Owner logic is not in F1.
- Do NOT add helpful filler ("Let me know if you have questions", "Hope that helps").
- Do NOT invent facts not in the work order.
- If the issue is marked urgent, you may prepend "URGENT: " to Message 1. Otherwise no urgency labels.

That's it. Two send_text calls, strict template, done.`;

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
