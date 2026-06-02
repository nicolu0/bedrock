// <system-reminder> block builder. The orchestrator turns each turn's event
// into a stack of reminders that prepend the user message content. Each block
// is its own <system-reminder>...</system-reminder> wrapper — easier to add /
// drop blocks conditionally and to read in logs.
//
// Per spec §6. Block list:
//   <event>                  — always: names the trigger (new_issue/incoming_user_message/incoming_anon_message)
//   # issue context          — new_issue: issue block + candidate vendors
//   # recent sends in chat   — incoming_user_message: numbered list of recent groupchat sends
//   # available skills       — always: skill menu (name + 1-line description)
//   # environment            — always: today's date + workspace label
//
// Deferred (introduced by later PRs, listed here so the order is fixed):
//   # about this person      — when handle has profile_notes (layered-memory PR)
//   # recalled beliefs       — workspace turns: top beliefs for the relevant entity

import { loadSkill, getMenu } from './skills.mjs';
import { recentSentForChat } from '../state/helpers.mjs';
import * as memory from '../memory.mjs';
import * as sessionizer from './sessionizer.mjs';

function reminder(content) {
	return `<system-reminder>\n${content}\n</system-reminder>`;
}

function slug(s) {
	return String(s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function formatIssueContext(issue, candidate_vendors) {
	const lines = [];
	if (issue.id) lines.push(`issue_id: ${issue.id}`);
	if (issue.property?.name) lines.push(`Property: ${issue.property.name}`);
	if (issue.unit?.name) lines.push(`Unit: ${issue.unit.name}`);
	if (issue.name) lines.push(`Title: ${issue.name}`);
	if (issue.description) lines.push(`Description: ${issue.description}`);
	if (issue.tenant?.name) lines.push(`Tenant: ${issue.tenant.name}`);
	if (issue.urgent) lines.push('Urgent: yes');
	const issueBlock = ['New work order:', ...lines].join('\n');

	// Candidate vendors: prefer the explicit list (issue-poller fetches workspace
	// vendors). Fall back to a single synthesized candidate from issue.vendor —
	// keeps eval fixtures working without a separate candidates field, matching
	// the pre-PR8.2 process_wo.buildContext fallback.
	let cands = Array.isArray(candidate_vendors) ? candidate_vendors : [];
	if (!cands.length && issue.vendor?.name) {
		cands = [
			{
				id: issue.vendor.id ?? `eval-vendor-${slug(issue.vendor.name)}`,
				name: issue.vendor.name
			}
		];
	}
	const candidatesBlock = cands.length
		? ['Candidate vendors:', ...cands.map((c) => `  - ${c.name} (id: ${c.id})`)].join('\n')
		: 'Candidate vendors: (none provided — rely on read_memory)';

	return `# issue context\n${issueBlock}\n\n${candidatesBlock}`;
}

function relativeAge(iso) {
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms) || ms < 0) return 'just now';
	const min = Math.round(ms / 60000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.round(hr / 24)}d ago`;
}

// Two sends within this window of each other count as a "burst" — sent close
// together, so a bare "yes" can't be pinned to one by recency (→ clarify).
const BURST_WINDOW_MS = 10 * 60 * 1000;

function formatRecentSends(bundles) {
	if (!bundles.length) {
		return '# open work orders in this chat\n(none open — nothing the reply could be approving)';
	}
	// Oldest first, newest last — the order the PM sees them. Each line shows its
	// age. Mark a clear "← most recent" ONLY when the newest send is well clear of
	// the next; if the top two went out close together it's a burst, left unmarked
	// so a bare "yes" reads as ambiguous (→ clarify) rather than auto-newest.
	const lastIdx = bundles.length - 1;
	let clearLatest = bundles.length === 1;
	if (bundles.length >= 2) {
		const newest = new Date(bundles[lastIdx].sent_at).getTime();
		const second = new Date(bundles[lastIdx - 1].sent_at).getTime();
		clearLatest = newest - second > BURST_WINDOW_MS;
	}
	const lines = bundles.map((b, i) => {
		const bodies = b.bodies.map((line) => `   ${line}`).join('\n');
		const age = b.sent_at ? relativeAge(b.sent_at) : 'unknown time';
		const tag = i === lastIdx && clearLatest ? '  ← most recent' : '';
		return `${i + 1}. [issue_id: ${b.issue_id}] (sent ${age})${tag}\n${bodies}`;
	});
	const header = clearLatest
		? '# open work orders in this chat (oldest first, newest last)'
		: '# open work orders in this chat (oldest first; the most recent were sent close together)';
	return [header, ...lines].join('\n\n');
}

function formatProfile(profile) {
	const slugs = Object.keys(profile || {}).sort();
	if (!slugs.length) {
		return '# profile\n(empty — no slugs stored for this handle yet)';
	}
	const lines = slugs.map((slug) => `${slug}: ${profile[slug]}`);
	return ['# profile', ...lines].join('\n');
}

function formatEnvironment(ctx) {
	const lines = [`date: ${new Date().toISOString().slice(0, 10)}`];
	if (ctx.workspace_label) lines.push(`workspace: ${ctx.workspace_label}`);
	return ['# environment', ...lines].join('\n');
}

function formatMenu(menu, loadedNames) {
	const loaded = new Set(loadedNames);
	const lines = menu.map(
		({ name, description }) =>
			`- ${name} — ${description}${loaded.has(name) ? ' (loaded)' : ''}`
	);
	return [
		'# available skills',
		...lines,
		'',
		'To load a skill mid-turn, call use_skill(name).'
	].join('\n');
}

// Build the array of reminder strings (each already wrapped in
// <system-reminder>...</system-reminder>). Caller joins with '\n\n'.
//
// Note (PR8.2): skill bodies are NOT injected here. They reach the model two
// ways:
//   - Preloaded (orchestrator concatenates the body with identityPrompt in
//     the system message) for unambiguous events like new_issue / incoming_anon_message.
//   - Mid-turn (model calls use_skill → body comes back as a tool result
//     wrapped in <skill_name>...</skill_name>) for heterogeneous events like
//     incoming_user_message, where the model decides whether the message warrants a skill.
// skillName: optional. If the event preloads a skill, pass the name so the
// menu can mark it (loaded) and the cache is warmed for the system-prompt
// loader. If the event has no preload, pass undefined — menu shows all skills
// without a loaded marker, and the model is expected to call use_skill.
export async function buildReminders(event, ctx, skillName) {
	const blocks = [];

	// <event> tag — always first. This is how the active skill (loaded into
	// the system prompt OR pulled via use_skill) decides which phase to apply.
	blocks.push(reminder(`<event>${event.type}</event>`));

	// Warm the cache if a skill is preloaded — keeps loadSkill in the
	// system-prompt loader hot. Skip when there's no preload.
	if (skillName) await loadSkill(skillName);

	// Event-specific situational blocks.
	if (event.type === 'new_issue') {
		const issue = event.payload?.issue ?? ctx.issue;
		const candidate_vendors = event.payload?.candidate_vendors ?? ctx.candidate_vendors;
		if (!issue) throw new Error('reminders: new_issue requires payload.issue');
		blocks.push(reminder(formatIssueContext(issue, candidate_vendors)));
	}

	if (event.type === 'incoming_user_message') {
		const chat_guid = event.payload?.chat_guid ?? ctx.chat_guid;
		if (!chat_guid) throw new Error('reminders: incoming_user_message requires payload.chat_guid');
		// Scope candidates to the live session: a fresh "yes" is about a work order
		// we raised in THIS conversation, not a stale one from days/sessions ago.
		// Eval mode (no live sessions) and a missing session fall open to the flat
		// window, preserving test behavior.
		let sessionStartedAt = null;
		if (process.env.BEDROCK_EVAL_MODE !== '1') {
			const session = await sessionizer.getOpenSession(chat_guid).catch(() => null);
			sessionStartedAt = session?.started_at ?? null;
		}
		const bundles = await recentSentForChat({ chat_guid, sessionStartedAt });
		blocks.push(reminder(formatRecentSends(bundles)));
	}

	if (event.type === 'incoming_anon_message') {
		// Per-handle profile slugs — the demo skill stages key off `system/stage`
		// and other slugs (user/name, property/<slug>, vendor/<trade>/<prop>).
		// Surfacing them as a reminder block lets the skill pick the right
		// stage without an extra read_profile call every turn.
		const handle = event.payload?.handle ?? ctx.handle;
		if (handle) {
			const profile = await memory.getProfile(handle).catch(() => ({}));
			blocks.push(reminder(formatProfile(profile)));
		}
	}

	// # available skills — always (menu of every skill in the registry, with
	// (loaded) marker on the active one). Per D1 + D4.
	const menu = await getMenu();
	blocks.push(reminder(formatMenu(menu, skillName ? [skillName] : [])));

	// # environment — always last.
	blocks.push(reminder(formatEnvironment(ctx)));

	return blocks;
}

// Compose the full user-message content for the turn: reminders concatenated,
// then (if the event has a "user said something" payload) the verbatim text
// with a one-line framing that anchors it to the active skill's phase.
// For new_issue there's no user text — the issue block is the whole content.
export function composeUserContent(event, reminderBlocks) {
	const reminderBody = reminderBlocks.join('\n\n');
	const userText = event.payload?.text ?? null;
	if (!userText) return reminderBody;
	// Framing cue. Empirically, a bare "yes" after a stack of reminders was
	// out-weighing the skill's "don't dispatch when ambiguous" rule — the
	// model treated the affirmative as decisive. The explicit phase pointer
	// + ambiguity reminder restores the old chat.mjs's "Decide and act per
	// the rules above" cue.
	const framing =
		event.type === 'incoming_user_message'
			? `The PM just sent: "${userText}"\n\nApply the incoming_user_message phase. Two SEPARATE decisions: (a) REPLY to the PM (almost always yes, a human-weighted reply per "Talking with the property manager" in your base instructions); (b) ACT on a work order (only when the reply resolves to one). Don't let "no action" become "no reply". The "# open work orders" block is scoped to this conversation, oldest→newest, each tagged with its age and the newest marked "← most recent". Resolve the reply to ONE work order by confidence (Step 0):\n- NONE open: take no dispatch action and draft no "which one?" question, but still REPLY. A bare "yes"/"ok" with nothing pending gets a natural "not sure what you're referring to, what's up?"; a question gets answered; a heads-up gets a brief ack. (read_memory/write_memory still fire if the message itself calls for it — they send no message.)\n- Reply names/points to one (issue, vendor, position): dispatch that one.\n- Exactly one open: an approval confirms it — dispatch, don't ask.\n- Exactly one open + approval: dispatch it. A "yes" right after the lone open work order is obvious — never ask "which one?".\n- Two or more genuinely open + a bare "yes" that names none: draft ONE clarifying question. This is the only case you ask, and it's rare — advancing status on each reply usually leaves just one open.\nWhenever a reply resolves a listed WO (dispatch, self-handle, defer, triage), call update_issue to advance its status so it leaves the list. Regardless of dispatch: reply to the PM, write_memory for any preference/correction, read_memory when you need prior context.`
			: userText;
	return `${reminderBody}\n\n${framing}`;
}
