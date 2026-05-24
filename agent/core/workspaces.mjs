// Shared workspace config. Imported by both the issue poller (which workspaces
// to fetch + which chat to draft into) and the chat poller in server.mjs (which
// groupchats to listen on + which senders count as the PM).
//
// pm_handles: the handles inside the chat that we treat as the property manager
// for correlation. Only messages from these handles are stored to the chat log
// and (later, F2 step 3+) routed to the correlator. Tenant/owner replies in the
// same groupchat are ignored.

export const WORKSPACES = {
	// Andrew's Workspace (test). Test chat is the 1:1 with my other Apple ID;
	// the PM handle for testing is that same id (I act as Jose when testing).
	'40d675ba-4dec-47dd-9222-79c0345c493f': {
		label: 'test',
		chatEnv: 'TEST_CHAT_GUID',
		pm_handles: ['andrew51@illinois.edu'],
		pm_label: 'Test User'
	},
	// LAPM (Vanessa) — prod. Jose has two phone numbers on the groupchat.
	// agent_handles: the cofounders' numbers in the chat. Pre-pivot they sent
	// real human messages; post-pivot they (and the Mac mini, via is_from_me)
	// act as the agent. Sessionizer + LLM prompts collapse these into one
	// "agent" persona so transcripts read correctly. The UI shows messages
	// from these handles on the "me" side of the conversation.
	'2e4373a0-40b8-42c2-a873-b08c99dbf76a': {
		label: 'prod',
		chatEnv: 'JOSE_CHAT_GUID',
		pm_handles: ['+13106990643', '+13102663152'],
		agent_handles: ['+19496566275', '+15109358199'],
		pm_label: 'jose'
	}
};

export function normalizeHandle(raw) {
	if (!raw) return '';
	const v = String(raw).trim();
	if (!v) return '';
	if (v.includes('@')) return v.toLowerCase();
	const cleaned = v.replace(/[^\d+]/g, '');
	if (cleaned.startsWith('+')) return `+${cleaned.slice(1).replace(/\D/g, '')}`;
	const d = cleaned.replace(/\D/g, '');
	if (d.length === 11 && d.startsWith('1')) return `+${d}`;
	if (d.length === 10) return `+1${d}`;
	if (d.length > 0) return `+${d}`;
	return v.toLowerCase();
}

// Map: chat_guid -> { workspace_id, label, pm_handles (Set of normalized) }.
// Only includes workspaces whose chatEnv is set in `env`.
export function buildChatGuidIndex(env = process.env) {
	const index = new Map();
	for (const [workspace_id, w] of Object.entries(WORKSPACES)) {
		const chat_guid = env[w.chatEnv];
		if (!chat_guid) continue;
		index.set(chat_guid, {
			workspace_id,
			label: w.label,
			pm_handles: new Set((w.pm_handles ?? []).map(normalizeHandle))
		});
	}
	return index;
}
