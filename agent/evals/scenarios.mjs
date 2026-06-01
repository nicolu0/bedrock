// Eval scenarios — hand-written test cases that the agent should pass on every
// run. Each prompt or tool change should be gated by `node agent/evals/run.mjs`
// showing no regressions.
//
// Scenario shape: { name, skill, setup?, ctx, expected }
//
//   skill    — 'demo' | 'process_wo' | 'chat'. Determines which skill the runner loads.
//   setup    — optional pre-populated state for this scenario:
//                sent_log:   rows pre-written to sent-log.json
//                chat_log:   rows pre-written to chat-log.json
//                drafts:     rows pre-written to drafts.json
//                supabase:   { [issue_id]: issue_row } — what fetchIssueById returns
//                memory:     { [handle]: { profile, observations } } — for demo skill
//   ctx      — the runTurn ctx. Augmented by the runner with sendMode + onEvent.
//   expected — assertions on the run's result:
//                tool_calls:        ordered list of tool names that should run
//                tool_calls_set:    unordered set of tool names (allows any order)
//                tool_calls_set_includes: subset assertion — every listed name must
//                                   appear; extras are allowed.
//                tool_calls_excludes: forbidden names — none may appear.
//                no_tools:          true if no tool calls should fire
//                drafts_count:      number of drafts created
//                drafts_channels:   array of channels for created drafts (set, unordered)
//                outbox_count:      number of live messages emitted
//                outbox_includes:   substrings the joined outbox must contain
//                drafts_include:    substrings the joined draft bodies must contain
//                failure_stage:     expected failure.stage value, or null for no failure
//                judge:             { criteria, target } — fuzzy criteria + which output to judge
//                                   target: 'drafts' | 'outbox' | 'all'

const HUB_CHAMPAIGN = '196dc99d-4fc7-4e83-9b14-25a14dfd4f1f';
const TEST_WS = '40d675ba-4dec-47dd-9222-79c0345c493f';
const TEST_CHAT = 'iMessage;-;andrew51@illinois.edu';
const NOW_ISO = () => new Date().toISOString();
const MINUTES_AGO = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

// Mock issue rows used across multiple chat scenarios.
// Post-units-table-normalization: unit.name is the canonical short address
// the agent uses VERBATIM for line 1. No more "Unit X at Property" construction.
const ISSUE_FAUCET = {
	id: 'iss-faucet-001',
	workspace_id: TEST_WS,
	property: { name: 'Hub Champaign' },
	unit: { name: 'Unit 701 Hub Champaign' },
	tenant: { name: 'Anna' },
	vendor: { name: 'Mario' },
	name: 'kitchen faucet leaking',
	description: 'tenant reports water pooling under the sink'
};

const ISSUE_AC = {
	id: 'iss-ac-002',
	workspace_id: TEST_WS,
	property: { name: 'Hub Champaign' },
	unit: { name: 'Unit 701 Hub Champaign' },
	tenant: { name: 'Anna' },
	vendor: { name: 'California Heat Air Conditioning' },
	name: 'AC not blowing cold',
	description: 'tenant says the AC will not cool the unit'
};

// ── Incident fixtures (2026-05-30 "Yes, please → clarify" bug) ───────────────
// Four work orders the agent texted Jose about. dryer+light+fridge were sent
// days earlier and Jose ALREADY answered each (self-handled / triage); laundry
// was the lone fresh send he replied "Yes, please" to. Base status is
// 'awaiting_pm' (open) so they appear as candidates; sim2 overrides the
// answered three to resolved states via the supabase mock.
const ISSUE_DRYER = {
	id: 'iss-dryer-026',
	workspace_id: TEST_WS,
	property: { name: '1447 Harvard St' },
	unit: { name: 'Unit 1 1447 Harvard St' },
	tenant: { name: 'Marisol' },
	vendor: { name: 'Cross Appliance' },
	name: 'dryer with a burning smell',
	description: 'tenant reports the dryer smells like it is burning',
	status: 'awaiting_pm'
};
const ISSUE_LIGHT = {
	id: 'iss-light-026',
	workspace_id: TEST_WS,
	property: { name: '1829 11th St' },
	unit: { name: 'Unit 2 1829 11th St' },
	tenant: { name: 'Priya' },
	vendor: { name: 'Abraham' },
	name: 'bathroom light fixture that needs replacement',
	description: 'the bathroom light fixture needs replacement',
	status: 'awaiting_pm'
};
const ISSUE_FRIDGE = {
	id: 'iss-fridge-026',
	workspace_id: TEST_WS,
	property: { name: '205 Horizon Ave' },
	unit: { name: 'Unit 3 205 Horizon Ave' },
	tenant: { name: 'Sam' },
	vendor: { name: 'Cross Appliance' },
	name: 'broken refrigerator drawer',
	description: 'the refrigerator drawer is broken',
	status: 'awaiting_pm'
};
const ISSUE_LAUNDRY = {
	id: 'iss-laundry-030',
	workspace_id: TEST_WS,
	property: { name: '824 11th St' },
	unit: { name: 'Unit 4 824 11th St' },
	tenant: { name: 'Lena' },
	vendor: { name: 'Cross Appliance' },
	name: 'laundry machine that is not draining',
	description: 'the laundry machine is not draining',
	status: 'awaiting_pm'
};

// Helper: build a sent-log bundle for the test chat referring to one issue.
// Line 1 = unit.name verbatim (canonical address from the normalized units table).
function sentBundle(issue, { ago_min = 5 } = {}) {
	const sent_at = MINUTES_AGO(ago_min);
	const bundle_id = `drf_${issue.id.replace(/[^a-z0-9]/g, '').slice(0, 16)}`;
	const body =
		`${issue.unit.name}\n` + `Has a ${issue.name}.\n\n` + `Should I send ${issue.vendor.name}?`;
	return [
		{
			sent_at,
			message_guid: `msg-${issue.id}-1`,
			bundle_id,
			part_index: 0,
			issue_id: issue.id,
			channel: 'groupchat',
			workspace_id: TEST_WS,
			workspace_label: 'test',
			chat_guid: TEST_CHAT,
			body
		}
	];
}

export const scenarios = [
	// ─── process_wo (read_memory → set_vendor → send_text) ──────────────────
	// The poller enriches the issue before runTurn, so the agent receives a
	// populated issue (property/unit/title) and never calls an enrich tool.
	// Scenario fixtures are already enriched to match.

	{
		name: 'process_wo: standard issue with vendor candidate → one multi-line draft',
		skill: 'process_wo',
		ctx: {
			issue: ISSUE_FAUCET,
			workspace_id: TEST_WS,
			sendMode: 'draft',
			workspace_label: 'test',
			chat_guid: TEST_CHAT
		},
		expected: {
			tool_calls_set_includes: ['read_memory', 'set_vendor', 'send_text'],
			drafts_count: 1,
			drafts_include: ['Unit 701', 'Hub Champaign', 'Mario', 'Should I send']
		}
	},

	{
		name: 'process_wo: no candidate vendor → read_memory + 1 draft, no vendor question',
		skill: 'process_wo',
		ctx: {
			issue: { ...ISSUE_FAUCET, vendor: null, name: 'wifi down' },
			workspace_id: TEST_WS,
			sendMode: 'draft',
			workspace_label: 'test'
		},
		expected: {
			tool_calls_set_includes: ['read_memory', 'send_text'],
			tool_calls_excludes: ['set_vendor'],
			drafts_count: 1,
			drafts_include: ['Unit 701', 'Hub Champaign'],
			drafts_excludes: ['Should I send', 'URGENT'],
			judge: {
				target: 'drafts',
				criteria:
					'The draft is a short two-line bubble about Unit 701 / Hub Champaign and a wifi issue. The second sentence must read as natural English (full prose, not a headline fragment, no colons/em dashes/semicolons, no ungrammatical "has wifi down"). Acceptable second-sentence phrasings: "Has no wifi.", "The wifi is down.", "Wifi is out.", or any other natural rewording.'
			}
		}
	},

	{
		name: 'process_wo: missing unit → location line is just the property',
		skill: 'process_wo',
		ctx: {
			issue: { ...ISSUE_FAUCET, unit: null, name: 'roof leak in lobby' },
			workspace_id: TEST_WS,
			sendMode: 'draft',
			workspace_label: 'test'
		},
		expected: {
			tool_calls_set_includes: ['read_memory', 'set_vendor', 'send_text'],
			drafts_count: 1,
			drafts_include: ['Hub Champaign', '\n\nShould I send Mario?'],
			drafts_excludes: ['Unit ', 'URGENT']
		}
	},

	{
		name: 'process_wo: awkward "has X" title → natural grammar on line 2',
		skill: 'process_wo',
		ctx: {
			issue: { ...ISSUE_FAUCET, name: 'dryer not working' },
			workspace_id: TEST_WS,
			sendMode: 'draft',
			workspace_label: 'test'
		},
		expected: {
			tool_calls_set_includes: ['read_memory', 'set_vendor', 'send_text'],
			drafts_count: 1,
			drafts_include: ['Unit 701', 'Hub Champaign', '\n\nShould I send Mario?'],
			drafts_excludes: ['has dryer not working', 'URGENT'],
			judge: {
				target: 'drafts',
				criteria:
					'The sentence describing the dryer issue reads as natural English — must NOT use a colon/em dash/semicolon, must NOT be a headline fragment. Acceptable phrasings: "Has a broken dryer.", "The dryer isn\'t working.", "Dryer is out.", or similar.'
			}
		}
	},

	{
		name: 'process_wo: long description gets compact line 2',
		skill: 'process_wo',
		ctx: {
			issue: {
				...ISSUE_FAUCET,
				description:
					'tenant reports that the kitchen faucet has been leaking for several days, water has been pooling under the sink and damaging the cabinet floor, the leak appears to come from the base of the faucet and is worse when hot water is used, they have placed towels but they need replacing constantly'
			},
			workspace_id: TEST_WS,
			sendMode: 'draft',
			workspace_label: 'test'
		},
		expected: {
			tool_calls_set_includes: ['read_memory', 'set_vendor', 'send_text'],
			drafts_count: 1,
			drafts_include: ['Unit 701', 'Hub Champaign', '\n\nShould I send Mario?', 'faucet'],
			drafts_excludes: ['URGENT', 'towels', 'cabinet', 'several days'],
			judge: {
				target: 'drafts',
				criteria:
					'The issue is summarized in ONE short sentence (under ~20 words) — NOT a multi-paragraph dump. Mentioning "faucet" is enough; "kitchen faucet" is also fine but not required.'
			}
		}
	},

	// ─── Chat (8) ──────────────────────────────────────────────────────────

	{
		name: 'chat: clear "yes" with one candidate → ack + tenant + vendor drafts + observation',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_FAUCET),
			supabase: { [ISSUE_FAUCET.id]: ISSUE_FAUCET }
		},
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			text: 'yes'
		},
		expected: {
			// Confirmation now also logs an observation of the dispatch decision.
			// Everything drafts (ack included), so nothing hits the outbox.
			tool_calls_set_includes: ['send_text', 'draft_tenant', 'draft_vendor', 'write_memory'],
			drafts_count: 3,
			drafts_channels: ['tenant_appfolio', 'vendor_appfolio'],
			drafts_include: ['Anna', 'Mario', 'kitchen faucet leaking'],
			outbox_count: 0
		}
	},

	{
		// Ambiguous approval: bare "yes" while TWO work orders are open. The agent
		// must NOT guess/dispatch — it drafts ONE clarifying question (send_text
		// draft:true → staged, not live) for the human to review and send.
		name: 'chat: "yes" with two open candidates → drafts a clarifying question',
		skill: 'chat',
		setup: {
			sent_log: [
				...sentBundle(ISSUE_FAUCET, { ago_min: 30 }),
				...sentBundle(ISSUE_AC, { ago_min: 5 })
			],
			supabase: { [ISSUE_FAUCET.id]: ISSUE_FAUCET, [ISSUE_AC.id]: ISSUE_AC }
		},
		ctx: { chat_guid: TEST_CHAT, workspace_label: 'test', text: 'yes' },
		expected: {
			tool_calls_set_includes: ['send_text'],
			tool_calls_excludes: ['draft_tenant', 'draft_vendor'],
			drafts_count: 1,
			outbox_count: 0,
			judge: {
				target: 'drafts',
				criteria:
					'A single clarifying question asking which of the two open work orders (the faucet vs. the AC) the PM meant. It must NOT pick one or dispatch.'
			}
		}
	},

	{
		// PM redirects to a different vendor than we suggested. Agent should
		// dispatch using the named vendor (passing vendor_name to the drafters)
		// AND record write_memory so the belief-former can learn from the swap.
		name: 'chat: vendor swap ("no send Luigi instead") → drafts with Luigi + write_memory',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_FAUCET),
			supabase: { [ISSUE_FAUCET.id]: ISSUE_FAUCET }
		},
		ctx: { chat_guid: TEST_CHAT, workspace_label: 'test', text: 'no send Luigi instead' },
		expected: {
			tool_calls_set_includes: ['send_text', 'draft_tenant', 'draft_vendor', 'write_memory'],
			// Everything drafts now (ack+question included), so nothing is live.
			drafts_count: 3,
			drafts_channels: ['tenant_appfolio', 'vendor_appfolio'],
			drafts_include: ['Anna', 'Luigi', 'kitchen faucet leaking'],
			outbox_count: 0
		}
	},

	{
		// Bare "send X" with no "instead" cue. This is the shape that broke
		// in production on 2026-05-24 ("Send yonic") — the agent didn't
		// recognize it as a swap and drafted with the original vendor.
		name: 'chat: bare vendor swap ("send Yonic") → drafts with Yonic, not Mario',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_FAUCET),
			supabase: { [ISSUE_FAUCET.id]: ISSUE_FAUCET }
		},
		ctx: { chat_guid: TEST_CHAT, workspace_label: 'test', text: 'send Yonic' },
		expected: {
			tool_calls_set_includes: ['send_text', 'draft_tenant', 'draft_vendor', 'write_memory'],
			// Everything drafts now (ack+question included), so nothing is live.
			drafts_count: 3,
			drafts_channels: ['tenant_appfolio', 'vendor_appfolio'],
			drafts_include: ['Anna', 'Yonic', 'kitchen faucet leaking'],
			outbox_count: 0
		}
	},

	{
		// Follow-up answer: the conversation history shows we asked WHY the PM
		// swapped to Luigi; their reply gives the reason. Capture it with
		// write_memory and nothing else — dispatch already happened on the
		// override turn, so no ack and no drafts. Recognition comes from history
		// (injected via ctx.history in eval mode by buildSessionHistory).
		name: "chat: follow-up answer (\"he's cheaper\") → write_memory only, no dispatch",
		skill: 'chat',
		setup: { sent_log: [], supabase: {} },
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			text: "he's cheaper for drain jobs",
			history: [
				{ role: 'user', content: 'no send Luigi instead' },
				{ role: 'assistant', content: 'On it, sending Luigi. Any reason you prefer him over Yonic?' }
			]
		},
		expected: {
			tool_calls_set_includes: ['write_memory'],
			tool_calls_excludes: ['send_text', 'draft_tenant', 'draft_vendor'],
			drafts_count: 0,
			outbox_count: 0
		}
	},

	{
		name: 'chat: info question ("what is the lockbox code?") → no_match',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_FAUCET),
			supabase: { [ISSUE_FAUCET.id]: ISSUE_FAUCET }
		},
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			text: 'what is the lockbox code for hub champaign?'
		},
		expected: { no_tools: true, drafts_count: 0, outbox_count: 0 }
	},

	{
		name: 'chat: ambiguous "ok" with no recent sends → no_match',
		skill: 'chat',
		setup: { sent_log: [], supabase: {} },
		ctx: { chat_guid: TEST_CHAT, workspace_label: 'test', text: 'ok' },
		expected: { no_tools: true, drafts_count: 0, outbox_count: 0 }
	},

	{
		name: 'chat: affirmative naming same vendor ("yep send Mario") → drafts',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_FAUCET),
			supabase: { [ISSUE_FAUCET.id]: ISSUE_FAUCET }
		},
		ctx: { chat_guid: TEST_CHAT, workspace_label: 'test', text: 'yep send Mario' },
		expected: {
			// Confirming our suggested vendor still logs the dispatch decision.
			tool_calls_set_includes: ['send_text', 'draft_tenant', 'draft_vendor', 'write_memory'],
			drafts_count: 3,
			drafts_channels: ['tenant_appfolio', 'vendor_appfolio']
		}
	},

	{
		name: 'chat: reply with no sent-log history → no_match',
		skill: 'chat',
		setup: { sent_log: [], supabase: {} },
		ctx: { chat_guid: TEST_CHAT, workspace_label: 'test', text: 'yes go ahead' },
		expected: { no_tools: true, drafts_count: 0 }
	},

	{
		// Regression for the 2026-05-18 incident: PM said "Assigned plumbing to
		// guox and I'll talk to them about the filter tomorrow" — the chat
		// skill model returned no tool calls but emitted "No action taken." as
		// plain assistant content, and the orchestrator's fallback auto-sent
		// that to the prod groupchat. Fix removes the fallback entirely; this
		// scenario asserts the outbox stays empty for a substantive
		// status-update reply that should produce zero physical messages.
		name: 'chat: PM self-handles issue ("assigned to guox, will talk tomorrow") → silent no_match',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_FAUCET),
			supabase: { [ISSUE_FAUCET.id]: ISSUE_FAUCET }
		},
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			text: "Assigned plumbing to guox and I'll talk to them about the filter tomorrow"
		},
		expected: {
			tool_calls_excludes: ['send_text', 'draft_tenant', 'draft_vendor'],
			drafts_count: 0,
			outbox_count: 0
		}
	},

	{
		name: 'chat: prod-chat sends do not leak into test-chat candidates',
		skill: 'chat',
		setup: {
			// Pre-load a prod chat send. Test chat candidates list should be empty.
			sent_log: [
				{
					sent_at: MINUTES_AGO(5),
					message_guid: 'prod-msg-1',
					bundle_id: 'prod-bundle-1',
					part_index: 0,
					issue_id: 'prod-issue',
					channel: 'groupchat',
					workspace_id: 'other-ws',
					workspace_label: 'prod',
					chat_guid: 'iMessage;+;800f91610cea448fb5085603ab3ea973',
					body: 'Unit 1 at 829 Ocean Park\nHas a leak.\n\nShould I send Yonic?'
				}
			],
			supabase: {}
		},
		ctx: { chat_guid: TEST_CHAT, workspace_label: 'test', text: 'yes' },
		expected: { no_tools: true, drafts_count: 0 }
	},

	// ─── Chat wo_status: lifecycle closure + the 2026-05-30 clarify bug ─────
	// Sim 1 — each kind of PM reply must advance the addressed WO's status via
	// update_issue. Sim 2 — once the answered WOs are resolved, a lone fresh
	// "Yes, please" dispatches instead of asking a clarifying question.

	{
		// Sim 1a — self-handle. Jose answered the dryer+light days ago with "I
		// already took care of those". Both are listed candidates; the reply must
		// close them (pm_handling), NOT dispatch and NOT clarify.
		name: 'chat wo_status: "I already took care of those" → update_issue pm_handling, no dispatch',
		skill: 'chat',
		setup: {
			sent_log: [
				...sentBundle(ISSUE_DRYER, { ago_min: 90 }),
				...sentBundle(ISSUE_LIGHT, { ago_min: 88 })
			],
			supabase: { [ISSUE_DRYER.id]: ISSUE_DRYER, [ISSUE_LIGHT.id]: ISSUE_LIGHT }
		},
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			text: 'I already took care of those work orders'
		},
		expected: {
			tool_args: { update_issue: { status: 'pm_handling' } },
			tool_calls_excludes: ['draft_tenant', 'draft_vendor'],
			drafts_count: 0,
			outbox_count: 0
		}
	},

	{
		// Sim 1b — triage. Jose redirects the fridge WO to gathering tenant info
		// rather than dispatching. Status must move to triaging.
		name: 'chat wo_status: "have the tenant send a photo first" → update_issue triaging',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_FRIDGE, { ago_min: 45 }),
			supabase: { [ISSUE_FRIDGE.id]: ISSUE_FRIDGE }
		},
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			text: 'Have the resident send a photo of the drawer and the model number of the fridge first'
		},
		expected: {
			tool_args: { update_issue: { status: 'triaging' } },
			drafts_count: 0
		}
	},

	{
		// Sim 1c — dispatch. Lone open WO, clean approval. Dispatch AND advance
		// status to dispatched so it leaves the candidate list.
		name: 'chat wo_status: lone "Yes, please" → dispatch + update_issue dispatched',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_LAUNDRY, { ago_min: 20 }),
			supabase: { [ISSUE_LAUNDRY.id]: ISSUE_LAUNDRY }
		},
		ctx: { chat_guid: TEST_CHAT, workspace_label: 'test', text: 'Yes, please' },
		expected: {
			tool_calls_set_includes: ['send_text', 'draft_tenant', 'draft_vendor', 'update_issue'],
			tool_args: { update_issue: { status: 'dispatched' } },
			drafts_count: 3,
			drafts_channels: ['tenant_appfolio', 'vendor_appfolio']
		}
	},

	{
		// Sim 2 — the incident replay. All four WOs are in the sent-log, but the
		// three Jose already answered are resolved in issues_v2 (pm_handling /
		// triaging). recentSentForChat filters them out, leaving laundry as the
		// ONLY open candidate — so "Yes, please" dispatches it instead of asking
		// "which one?". This is the exact bug from 2026-05-30.
		name: 'chat wo_status: resolved WOs excluded → lone "Yes, please" dispatches, not clarifies',
		skill: 'chat',
		setup: {
			sent_log: [
				...sentBundle(ISSUE_DRYER, { ago_min: 6000 }),
				...sentBundle(ISSUE_LIGHT, { ago_min: 6000 }),
				...sentBundle(ISSUE_FRIDGE, { ago_min: 5800 }),
				...sentBundle(ISSUE_LAUNDRY, { ago_min: 30 })
			],
			supabase: {
				[ISSUE_DRYER.id]: { ...ISSUE_DRYER, status: 'pm_handling' },
				[ISSUE_LIGHT.id]: { ...ISSUE_LIGHT, status: 'pm_handling' },
				[ISSUE_FRIDGE.id]: { ...ISSUE_FRIDGE, status: 'triaging' },
				[ISSUE_LAUNDRY.id]: { ...ISSUE_LAUNDRY, status: 'awaiting_pm' }
			}
		},
		ctx: { chat_guid: TEST_CHAT, workspace_label: 'test', text: 'Yes, please' },
		expected: {
			tool_calls_set_includes: ['send_text', 'draft_tenant', 'draft_vendor'],
			drafts_count: 3,
			drafts_channels: ['tenant_appfolio', 'vendor_appfolio'],
			judge: {
				target: 'drafts',
				criteria:
					'An ack confirming dispatch of the laundry machine work order (e.g. "got it" / "on it") plus tenant and vendor dispatch drafts. It must NOT be a clarifying question asking which work order the PM meant.'
			}
		}
	},

	// ─── Chat: learning behavior (new tools) ───────────────────────────────

	{
		name: 'chat: stated preference ("always use Yonic for plumbing") → write_memory, no dispatch',
		skill: 'chat',
		setup: { sent_log: [], supabase: {} },
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			text: 'btw always use Yonic for plumbing at the Hub Champaign building'
		},
		expected: {
			tool_calls_set_includes: ['write_memory'],
			tool_calls_excludes: ['send_text', 'draft_tenant', 'draft_vendor'],
			drafts_count: 0,
			outbox_count: 0
		}
	},

	{
		name: 'chat: per-property quirk (elevator vendor) → write_memory, no dispatch',
		skill: 'chat',
		setup: { sent_log: [], supabase: {} },
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			text: 'fyi the elevator vendor for 1234 Main St is Acme Elevators, they have a contract'
		},
		expected: {
			tool_calls_set_includes: ['write_memory'],
			tool_calls_excludes: ['send_text', 'draft_tenant', 'draft_vendor'],
			drafts_count: 0,
			outbox_count: 0
		}
	},

	{
		name: 'chat: dispatch + side-channel preference in one message → both fire',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_FAUCET),
			supabase: { [ISSUE_FAUCET.id]: ISSUE_FAUCET }
		},
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			// Confirms dispatch on the listed issue AND drops a generalizable
			// preference. Both should fire: drafts for the confirmation, an
			// observation for the rule.
			text: 'yes go ahead. and just so you know we always use Yonic for plumbing here.'
		},
		expected: {
			tool_calls_set_includes: ['send_text', 'draft_tenant', 'draft_vendor', 'write_memory'],
			drafts_count: 3,
			drafts_channels: ['tenant_appfolio', 'vendor_appfolio']
		}
	},

	// ─── Demo (5) ──────────────────────────────────────────────────────────

	{
		name: 'demo: first message fires canned opener (no LLM call)',
		skill: 'demo',
		ctx: { handle: '+19000000001', text: 'hi', sendMode: 'live' },
		expected: {
			no_tools: true,
			outbox_count: 2,
			outbox_includes: ["i'm bedrock", 'run through an example']
		}
	},

	{
		name: 'demo: user agrees ("yes") → setup stage + property question',
		skill: 'demo',
		setup: {
			// Pretend the opener has already fired by pre-seeding the conversation log.
			memory: {
				'+19000000002': {
					profile: {},
					observations: [],
					conversation: [
						{ role: 'user', content: 'hi' },
						{
							role: 'assistant',
							content:
								"hey, i'm bedrock. i handle work orders for property managers, all over text. no logging into your pms, no chasing tenants or vendors. that's my job.\nwant to run through an example together?"
						}
					]
				}
			}
		},
		ctx: { handle: '+19000000002', text: 'yes', sendMode: 'live' },
		expected: {
			tool_calls_set: ['write_profile', 'send_text'],
			judge: {
				target: 'outbox',
				criteria:
					'The assistant should ask the user for the name of a property they manage. Phrasing should be a single short question. Voice is lowercase, casual, no formal greetings.'
			}
		}
	},

	{
		name: 'demo: user names a property → stored + plumber question',
		skill: 'demo',
		setup: {
			memory: {
				'+19000000003': {
					profile: { 'system/stage': 'setup' },
					observations: [],
					conversation: [
						{ role: 'user', content: 'hi' },
						{
							role: 'assistant',
							content:
								"alright, let's run through a plumbing example. what's a property you manage?"
						}
					]
				}
			}
		},
		ctx: { handle: '+19000000003', text: 'we manage mariposa apartments', sendMode: 'live' },
		expected: {
			tool_calls_set: ['write_profile', 'send_text'],
			judge: {
				target: 'outbox',
				criteria:
					'The assistant should ask who their plumber is for the property. Acceptable to refer to the property via referential language ("there", "for that one") instead of saying "mariposa" explicitly — that matches the voice rules. Lowercase, casual.'
			}
		}
	},

	{
		name: 'demo: user names a vendor → stored + dispatch starts',
		skill: 'demo',
		setup: {
			memory: {
				'+19000000004': {
					profile: { 'system/stage': 'setup', 'property/mariposa': 'true' },
					observations: [],
					conversation: [
						{ role: 'user', content: 'hi' },
						{ role: 'assistant', content: "what's a property you manage?" },
						{ role: 'user', content: 'mariposa' },
						{ role: 'assistant', content: "who's your plumber for mariposa?" }
					]
				}
			}
		},
		ctx: { handle: '+19000000004', text: 'mario', sendMode: 'live' },
		expected: {
			tool_calls_set: ['write_profile', 'write_profile', 'send_text'],
			judge: {
				target: 'outbox',
				criteria:
					'The assistant should transition into a work-order dispatch scenario at mariposa, framing the example as if a tenant just submitted a maintenance request. Should mention mario somewhere (as the suggested vendor). Lowercase, casual.'
			}
		}
	},

	{
		name: 'demo: followup → complete transition fires closer + endTurn',
		skill: 'demo',
		setup: {
			memory: {
				'+19000000005': {
					profile: {
						'system/stage': 'followup',
						'property/mariposa': 'true',
						'vendor/plumbing/mariposa': 'mario'
					},
					observations: [
						{
							ts: NOW_ISO(),
							content: 'mario is the default plumber for mariposa',
							tags: ['preference']
						}
					],
					conversation: [
						{ role: 'user', content: 'yes' },
						{
							role: 'assistant',
							content:
								"i'll also keep an eye on open work orders. let's fast forward a few days. mario and the tenant have gone quiet, want me to follow up?"
						}
					]
				}
			}
		},
		ctx: { handle: '+19000000005', text: 'yes', sendMode: 'live' },
		expected: {
			tool_calls_set: ['send_text', 'write_profile'],
			outbox_includes: ["that's how we'll usually handle work orders", 'any questions'],
			judge: {
				target: 'outbox',
				criteria:
					'The outbox must contain a short confirmation that the agent is pinging both (something like "on it, pinging both for an update"). The closer messages ("that\'s how we\'ll usually handle work orders" and "any questions?") must also appear in the outbox. Do NOT evaluate stage transitions — that\'s a tool call, not visible in the output text.'
			}
		}
	},

	// ─── read_memory (PR5) ─────────────────────────────────────────────────────
	// The read_memory tool is the agent's one entry point into the memory graph.
	// These scenarios verify that chat learns to call it in the right contexts
	// with the right hints. Under BEDROCK_EVAL_MODE read_memory short-circuits to
	// an empty candidates list — we assert the tool was CALLED, not what it
	// returned.

	{
		name: 'chat: read_memory fires for vendor-pick question with property hint',
		skill: 'chat',
		setup: {
			sent_log: [],
			supabase: {}
		},
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			workspace_id: TEST_WS,
			text: 'who do we use for plumbing at 17 Ozone Ave?'
		},
		expected: {
			tool_calls_set_includes: ['read_memory'],
			tool_calls_excludes: ['recall_beliefs', 'recall_observations']
		}
	},

	{
		name: 'chat: read_memory fires for vendor history question',
		skill: 'chat',
		setup: { sent_log: [], supabase: {} },
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			workspace_id: TEST_WS,
			text: 'have we used Yonic before?'
		},
		expected: {
			tool_calls_set_includes: ['read_memory'],
			tool_calls_excludes: ['recall_beliefs', 'recall_observations']
		}
	},

	{
		name: 'chat: stated preference recorded as memory write (no read_memory needed)',
		skill: 'chat',
		setup: { sent_log: [], supabase: {} },
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			workspace_id: TEST_WS,
			text: 'always use Yonic for plumbing at Hub Champaign'
		},
		expected: {
			tool_calls_set_includes: ['write_memory'],
			tool_calls_excludes: ['recall_beliefs', 'recall_observations'],
			drafts_count: 0,
			outbox_count: 0
		}
	},

	{
		name: 'chat: read_memory used to verify before dispatch on ambiguous "yes"',
		skill: 'chat',
		setup: {
			sent_log: sentBundle(ISSUE_FAUCET),
			supabase: { [ISSUE_FAUCET.id]: ISSUE_FAUCET }
		},
		ctx: {
			chat_guid: TEST_CHAT,
			workspace_label: 'test',
			workspace_id: TEST_WS,
			text: 'yes go with whoever you think is best for plumbing here'
		},
		expected: {
			tool_calls_set_includes: ['read_memory'],
			tool_calls_excludes: ['recall_beliefs', 'recall_observations']
		}
	}
];
