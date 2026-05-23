// process_wo skill — a new work order has just landed in issues_v2. The
// agent enriches it from AppFolio + memory, picks a vendor, drafts a 1–2
// bubble ping to the PM's groupchat. Replaces the old f1 slot-fill skill
// AND the deprecated intake-agent + vendor-agent edge functions.

import { sendText } from '../tools/send_text.mjs';
import { enrichIssue } from '../tools/enrich_issue.mjs';
import { readMemory } from '../tools/read_memory.mjs';
import { setVendor } from '../tools/set_vendor.mjs';

const PROCESS_WO_TASK_PROMPT = `# Task: process a new work order

A new work order just landed. Walk it through this pipeline, then STOP:

  1. **enrich_issue(issue_id)** — always. Fills in unit, a clean description, a short title, and the urgent flag. Without this you may be missing the unit number, the urgency label, or a usable description.
  2. **read_memory(question, property?, vendor?, issue?)** — always. Surface the workspace's vendor preferences, per-property quirks, and any legacy vendor list for the trade. Pass the property name from enrich_issue as the \`property\` hint and the issue title/description as \`issue\`. The candidates come back sorted with provenance strings — read them.
  3. **Pick a vendor.** If the inline "Candidate vendors" list has at least one entry, pick the best one — read_memory's provenance strings guide the choice (high-confidence beliefs and recent positive observations win), but having any candidate is enough; do not bail out just because read_memory came back thin. Skip set_vendor ONLY when the candidate list is empty (e.g. the work order is a wifi/internet ticket with no matching trade).
  4. **set_vendor(issue_id, vendor_id)** — call this when you picked. Use the UUID from the candidate list, not the name.
  5. **send_text** — 1 or 2 messages per the rules below.

## Message rules

You send 1 or 2 iMessages to the property manager via send_text:

- If you picked a vendor (called set_vendor): send EXACTLY 2 messages.
- If you did not pick a vendor: send EXACTLY 1 message. Do NOT call send_text again. Do NOT ask a follow-up.

Message 1 (always): one short, natural-sounding English sentence that says which unit/property and what the issue is. Write it like a person texting another person — full prose, real grammar, no colons, no em dashes, no headline shorthand.
Message 2 (only if vendor): "Should we send {vendor}?"

## Field rules

- Message 1 must convey three things in one short sentence: the unit (if present), the property, and **the title** (from enrich_issue's \`name\` field, or the "Title:" line in the work-order block). The "Description:" line is supplementary context only — never use it as the message subject. If Title and Description seem to describe different things, trust the Title. Beyond that, write whatever flows naturally. A few shapes that work:
  - "Unit {unit} at {property} has {a/an/no ...}." → "Unit 701 at Hub Champaign has a leaky faucet." / "Unit 701 at Hub Champaign has no wifi."
  - "Unit {unit} at {property}'s {thing} is {state}." → "Unit 701 at Hub Champaign's wifi is down." / "Unit 5 at Mariposa's dryer isn't working."
  - "The {thing} at unit {unit}, {property} is {state}." → "The dryer at Unit 5, Mariposa isn't working."
  Pick the one that reads most naturally for the given title. Rewrite the title's words freely to make the sentence flow — don't paste the raw title in if it makes the grammar awkward.
- Forbidden in Message 1: colons, em dashes, semicolons, sentence fragments, headline style ("Unit 701: wifi down"), or ungrammatical "has {bare phrase}" constructions ("has dryer not working", "has wifi down", "has front door buzzer broken"). If "has X" would be awkward, restructure the sentence.
- Length: one sentence, under 15 words. No "and" connecting multiple problems — pick the most important detail and drop the rest.
- Unit handling: if unit is missing, drop the "Unit {unit} at " prefix and lead with the property ("Lincoln Lobby has a broken front door buzzer.").
- {vendor}: exactly as named in the candidate list. First name only for individuals (Yonic, Abraham, Mario). Full name for companies (LA Hydro Jet, Cross Appliance Inc).
- Urgent issues: prepend "URGENT: " to Message 1. Otherwise no urgency label.

## Hard rules

- After the appropriate send_text call(s), STOP. Do not call any tool again. Do not produce plain text content. Return.
- One send_text per message — never put both messages in a single call.
- Always call enrich_issue and read_memory before send_text — even if the work-order block looks populated, the pipeline is the discipline.
- No greetings ("Hey", "Hi"), no signoffs, no emoji, no markdown.
- Never mention owners or owner approval.
- Never add filler ("Let me know", "Hope that helps").
- Never emit "{vendor}", "Should we send ?", or unfilled placeholder text.
- Never invent facts that aren't in enrich_issue's return or the work-order context.

## Examples

Standard (unit + confident vendor):
  enrich_issue → { property: "829 Ocean Park", unit: "1", name: "Leaking kitchen faucet" }
  read_memory  → belief "Yonic handles plumbing at 829 Ocean Park" (conf 0.85)
  set_vendor(issue_id, yonic_id)
  Send: "Unit 1 at 829 Ocean Park has a leaky faucet."
  Send: "Should we send Yonic?"

No confident vendor (e.g. wifi issue, no plumbing/electrical match):
  enrich_issue → { property: "Hub Champaign", unit: "701", name: "Wifi down" }
  read_memory  → no relevant beliefs, no trade match
  (skip set_vendor)
  Send: "Unit 701 at Hub Champaign has no wifi."
  [STOP — no second message, no further tool calls]

Urgent:
  enrich_issue → { urgent: true, ... }
  Prepend "URGENT: " to message 1.

Unit missing (single-family property):
  enrich_issue → { property: "Lincoln Lobby", unit: null, name: "Front door buzzer broken" }
  Drop the "Unit X at " prefix: "Lincoln Lobby has a broken front door buzzer."`;

function slug(s) {
	return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function formatIssue(issue) {
	const lines = ['New work order:'];
	if (issue.id) lines.push(`issue_id: ${issue.id}`);
	if (issue.property?.name) lines.push(`Property: ${issue.property.name}`);
	if (issue.unit?.name) lines.push(`Unit: ${issue.unit.name}`);
	if (issue.name) lines.push(`Title: ${issue.name}`);
	if (issue.description) lines.push(`Description: ${issue.description}`);
	if (issue.tenant?.name) lines.push(`Tenant: ${issue.tenant.name}`);
	if (issue.urgent) lines.push('Urgent: yes');
	return lines.join('\n');
}

function formatCandidates(candidates) {
	if (!candidates.length) {
		return 'Candidate vendors: (none provided — rely on read_memory)';
	}
	const lines = candidates.map((c) => `  - ${c.name} (id: ${c.id})`);
	return ['Candidate vendors:', ...lines].join('\n');
}

export const processWoSkill = {
	name: 'process_wo',
	model: process.env.WORK_ORDERS_MODEL || 'gpt-5.4-2026-03-05',
	maxIterations: 8,
	maxTokens: 500,
	tools: [enrichIssue, readMemory, setVendor, sendText],
	// Transitional: the slot-fill drafting prompt occasionally emits a draft as
	// plain content instead of a send_text call. Keep the orchestrator's
	// fallback until the prompt is tightened.
	allowPlainContentSend: true,
	taskPrompt: PROCESS_WO_TASK_PROMPT,
	async buildContext(ctx) {
		if (!ctx.issue) throw new Error('process_wo skill: ctx.issue required');

		// Vendor candidates: prefer ctx.candidate_vendors (issue-poller fetches
		// the workspace's vendor list and passes it in). Fall back to a single
		// candidate synthesized from ctx.issue.vendor for eval/legacy fixtures —
		// keeps existing scenarios working without a separate candidates field.
		let candidates = Array.isArray(ctx.candidate_vendors) ? ctx.candidate_vendors : [];
		if (!candidates.length && ctx.issue.vendor?.name) {
			candidates = [
				{
					id: ctx.issue.vendor.id ?? `eval-vendor-${slug(ctx.issue.vendor.name)}`,
					name: ctx.issue.vendor.name
				}
			];
		}

		return [
			{
				role: 'user',
				content: `${formatIssue(ctx.issue)}\n\n${formatCandidates(candidates)}`
			}
		];
	}
};
