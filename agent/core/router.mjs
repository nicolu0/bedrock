// Event → resolution router. Maps a normalized AgentEvent to:
//   - which skill (SKILL.md) to load
//   - per-event hooks (preCheck before LLM, commit after LLM, history builder)
//   - per-event runtime flags (allowPlainContentSend, model override, etc.)
//
// Triggers (server.mjs, issue-poller.mjs, cli.mjs) emit events; the orchestrator
// asks this router how to handle each one. Adding a new event type is one entry
// here plus any hooks it needs.
//
// An event is { type: string, payload: object }. The orchestrator passes the
// full event AND ctx through to hooks so they can inspect payload fields.

import { ingestDemoUserMessage, demoPreCheck, demoCommit } from './demo-state.mjs';
import { buildSessionHistory } from './history.mjs';

// Resolution shape:
//   {
//     skill?:                 string,     // SKILL.md to preload into system prompt; omit
//                                         // for heterogeneous events where the model
//                                         // should decide whether to call use_skill.
//     model?:                 string,     // override default model
//     maxIterations?:         number,
//     maxTokens?:             number,
//     allowPlainContentSend?: boolean,    // safety-net fallback when model emits plain content
//     preCheck?:    async (event, ctx) => result | null,
//     commit?:      async (event, ctx) => void,
//     buildHistory?: async (event, ctx) => OpenAI prior-turn messages array
//   }
//
// Preload guidance:
//   - Preload when the trigger is unambiguous (poll-driven, single workflow).
//   - DON'T preload when the trigger fires on heterogeneous input (e.g. any PM
//     message in a mapped groupchat — could be a dispatch reply, a preference
//     statement, or just "running late"). Let the model read the message + the
//     skills menu in the system-reminder, and call use_skill if a workflow
//     match is obvious. This keeps casual replies casual instead of forcing the
//     skill's framing on every turn.
const RESOLUTIONS = {
	new_issue: {
		skill: 'process_work_order',
		model: process.env.WORK_ORDERS_MODEL || 'gpt-5.4-2026-03-05',
		maxIterations: 8,
		maxTokens: 500,
		allowPlainContentSend: true
	},
	incoming_user_message: {
		// No skill preload — heterogeneous trigger. Model decides via use_skill.
		model: process.env.CHAT_MODEL || 'gpt-5.4-2026-03-05',
		maxIterations: 6,
		allowPlainContentSend: false,
		// Feed the open-session transcript as prior turns so the model can see the
		// conversation (and its own earlier messages), not just the latest line.
		buildHistory: buildSessionHistory
	},
	incoming_anon_message: {
		skill: 'demo',
		model: process.env.OPENAI_MODEL || 'gpt-5.4-2026-03-05',
		maxIterations: 8,
		allowPlainContentSend: true,
		preCheck: async (_event, ctx) => demoPreCheck(ctx),
		commit: async (_event, ctx) => demoCommit(ctx),
		buildHistory: async (_event, ctx) => ingestDemoUserMessage(ctx.handle, ctx.text)
	}
};

export function resolveEvent(event) {
	const resolution = RESOLUTIONS[event?.type];
	if (!resolution) throw new Error(`unknown event type: ${event?.type}`);
	return resolution;
}

export function listEventTypes() {
	return Object.keys(RESOLUTIONS);
}
