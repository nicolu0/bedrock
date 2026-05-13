// Core orchestrator. Mode-agnostic dispatcher.
//
// runTurn picks the right subagent based on (trigger, mode in ctx) and forwards
// to its implementation. Subagents (agent/demo, agent/work-orders) each own
// their own prompts, tools, and run loop.
//
// Triggers in v1:
//   inbound_message  → demo subagent (1:1 iMessage from any unknown handle)
//   new_issue        → work-orders subagent (new ready row in issues_v2)
//
// F2 will add:
//   groupchat_reply  → work-orders subagent (reply in a mapped work-orders chat)

import { runInboundTurn } from '../demo/orchestrator.mjs';
import { runIssueTurn } from '../work-orders/orchestrator.mjs';

export async function runTurn({ trigger, ctx = {}, input }) {
	if (!trigger) throw new Error('runTurn: trigger is required');
	if (trigger === 'inbound_message') {
		const { handle, text } = input ?? {};
		if (!handle) throw new Error('inbound_message: input.handle is required');
		return runInboundTurn(handle, text, { onEvent: ctx.onEvent, ctx });
	}
	if (trigger === 'new_issue') {
		if (!input?.issue) throw new Error('new_issue: input.issue is required');
		return runIssueTurn({ issue: input.issue, ctx });
	}
	throw new Error(`runTurn: unknown trigger ${trigger}`);
}

// Re-export demo conversation helpers for the CLI testbed.
export { resetConversation, getConversation } from '../demo/orchestrator.mjs';
