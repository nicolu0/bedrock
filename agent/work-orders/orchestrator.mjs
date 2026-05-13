// Work-orders subagent orchestrator.
//
// runIssueTurn: takes a ready issue, runs the new_issue situational prompt
// against the LLM with the work-orders tool set, and returns the accumulated
// send_text bundle. No event streaming — the draft just appears in the UI
// when ready (no live human is waiting on dots).

import { PROMPTS, buildIssueUserMessage } from './prompts.mjs';
import { TOOL_DEFS, executeTool } from './tools.mjs';

const OPENAI_MODEL = process.env.WORK_ORDERS_MODEL || 'gpt-4.1-mini';
const MAX_TOOL_LOOPS = 3;

export async function runIssueTurn({ issue, ctx = {} }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	ctx.drafts = [];
	const trigger = 'new_issue';
	const systemPrompt = PROMPTS[trigger];
	if (!systemPrompt) throw new Error(`no prompt for trigger: ${trigger}`);

	const working = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: buildIssueUserMessage(issue) }
	];

	for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
		const res = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: OPENAI_MODEL,
				messages: working,
				tools: TOOL_DEFS,
				tool_choice: 'auto',
				max_tokens: 300
			})
		});
		if (!res.ok) {
			throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
		}
		const data = await res.json();
		const choice = data.choices?.[0];
		if (!choice) break;
		const msg = choice.message ?? {};
		const toolCalls = msg.tool_calls ?? [];

		if (!toolCalls.length) {
			// Model returned plain content with no tool calls — done.
			break;
		}

		working.push({
			role: 'assistant',
			content: msg.content ?? null,
			tool_calls: toolCalls
		});

		for (const tc of toolCalls) {
			let args = {};
			try {
				args = JSON.parse(tc.function?.arguments || '{}');
			} catch {
				/* keep empty */
			}
			const result = await executeTool(tc.function?.name, args, ctx);
			working.push({
				role: 'tool',
				tool_call_id: tc.id,
				content: JSON.stringify(result)
			});
		}

		// If the model finished naturally (stop reason), bail.
		if (choice.finish_reason === 'stop') break;
	}

	return { messages: ctx.drafts ?? [] };
}
