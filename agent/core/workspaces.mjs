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
		display: 'Test',
		chatEnv: 'TEST_CHAT_GUID',
		pm_handles: ['andrew51@illinois.edu'],
		pm_label: 'Test User'
	},
	// LAPM (Vanessa) — first customer. Jose has two phone numbers on the groupchat.
	// agent_handles: the cofounders' numbers in the chat. Pre-pivot they sent
	// real human messages; post-pivot they (and the Mac mini, via is_from_me)
	// act as the agent. Sessionizer + LLM prompts collapse these into one
	// "agent" persona so transcripts read correctly. The UI shows messages
	// from these handles on the "me" side of the conversation.
	// label stays 'prod' for now (state files + runtime still key on it); the
	// UI shows display:'LAPM'. Full prod→lapm rename is a separate coordinated pass.
	'2e4373a0-40b8-42c2-a873-b08c99dbf76a': {
		label: 'prod',
		display: 'LAPM',
		chatEnv: 'JOSE_CHAT_GUID',
		// AppFolio Reports API access (global APPFOLIO_* creds point at this
		// vhost). Workspaces without it (Green Oak — crawler-only, no Reporting
		// API) must skip the reports fetch in enrich_issue and derive everything
		// from the WO email text instead.
		appfolioApi: true,
		// AppFolio tenant subdomain — the per-account boundary. The send runner
		// keys its session state + login on this so it can never act in the wrong
		// account. Login email is the workspace `alias`; password is per-account
		// in .env (APPFOLIO_PW_<SLUG>). See appfolio/session.mjs.
		appfolioVhost: 'lapm.appfolio.com',
		// Each AppFolio workspace gets its OWN dedicated runner PROCESS on this
		// local port (own browser, own session, own login held in isolation).
		// server.mjs spawns one per workspace; the UI routes per draft.workspace_id.
		// LAPM keeps 9773 for back-compat with the original single-runner default.
		appfolioRunnerPort: 9773,
		pm_handles: ['+13106990643', '+13102663152'],
		agent_handles: ['+19496566275', '+15109358199'],
		pm_label: 'Jose'
	},
	// Green Oak Property Management — second customer (AppFolio, no Reporting
	// API → Playwright crawler). Group chat participants: nico + Andrew are the
	// Bedrock side (agent_handles, rendered on the "me" side); brad (owner) +
	// brooke (PM) are the customer side (pm_handles). The agent itself sends as
	// the bedrock/650 account via is_from_me. Keep GREENOAK_CHAT_GUID UNSET in
	// .env until the crawler has loaded Green Oak's data — once set, the agent
	// goes live in this chat.
	'5406e04f-8e22-4ed8-a54e-a6d08ff45ef7': {
		label: 'greenoak',
		display: 'Green Oak',
		chatEnv: 'GREENOAK_CHAT_GUID',
		appfolioVhost: 'greenoakpropertymanagement.appfolio.com',
		appfolioRunnerPort: 9774,
		pm_handles: ['+18472742377', '+18055046160'],
		agent_handles: ['+19496566275', '+15109358199'],
		pm_label: 'Brooke'
	}
};

// Workspace list for the control-panel selector: { id, label, display }.
// Customers first (insertion order), the test workspace pinned last. The UI
// keys switching on `id` (the UUID) and tags local rows by `label`.
export function listWorkspacesForUi() {
	return Object.entries(WORKSPACES)
		.map(([id, w]) => ({ id, label: w.label, display: w.display ?? w.label }))
		.sort((a, b) => (a.label === 'test' ? 1 : 0) - (b.label === 'test' ? 1 : 0));
}

// AppFolio tenant subdomain for a workspace (null if it has no AppFolio account).
// The send runner uses this to scope its session + login to the right account.
export function appfolioVhostFor(workspace_id) {
	return WORKSPACES[workspace_id]?.appfolioVhost ?? null;
}

// Workspaces that have an AppFolio account the send runner can drive, each with
// the fixed local port its DEDICATED runner process listens on. server.mjs
// spawns one isolated runner per entry (own browser + login); the UI routes each
// draft to its workspace's port. One runner only ever holds one account — the
// process boundary is what makes a cross-account send structurally impossible.
export function appfolioRunnerTargets() {
	return Object.entries(WORKSPACES)
		.filter(([, w]) => w.appfolioVhost && w.appfolioRunnerPort)
		.map(([id, w]) => ({
			workspace_id: id,
			label: w.label,
			vhost: w.appfolioVhost,
			port: w.appfolioRunnerPort
		}));
}

// { workspace_id: port } map for the UI to pick the right runner per draft.
export function appfolioRunnerPorts() {
	return Object.fromEntries(appfolioRunnerTargets().map((t) => [t.workspace_id, t.port]));
}

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
