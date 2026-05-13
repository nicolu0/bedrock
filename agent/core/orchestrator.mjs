// THE orchestrator — the only place OpenAI is called.
//
//   runTurn(skill, ctx)
//
// Skill shape (see agent/skills/*.mjs):
//   {
//     name, model, maxIterations, maxTokens?,
//     tools: [{ name, description, parameters, run(args, ctx) }, ...],
//     taskPrompt: string | (ctx) => string,
//     buildContext: (ctx) => OpenAI messages array,
//     preCheck?:  (ctx) => result | null,    // short-circuit before LLM
//     commit?:    (ctx) => void              // post-LLM hook
//   }
//
// Tool result conventions (generic — orchestrator never names a tool):
//   { ...result, assistantContent?: string, endTurn?: boolean }
//     assistantContent — concatenated into the assistant content of the
//       working messages so the model reads its own speech as text on the
//       next iteration. (send_text uses this; other tools normally don't.)
//     endTurn — break the loop after this tool runs. Used by tools that
//       speak the final word of a turn (e.g., set_demo_stage's closer).
//
// Grep-test invariant: this file must contain zero references to specific
// skill names (f1, demo, chat) or specific tool names (send_text, etc.).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityPrompt } from '../identity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TURNS_LOG_PATH = path.join(__dirname, '..', 'work-orders', 'state', 'turns.jsonl');

const DEFAULT_MAX_ITERATIONS = 8;
const decoder = new TextDecoder();

async function appendTurnLog(entry) {
	try {
		await fs.appendFile(TURNS_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
	} catch {
		// Never fail a turn because observability logging failed.
	}
}

function toOpenAIToolDefs(tools) {
	return (tools ?? []).map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters
		}
	}));
}

async function* parseSSEStream(response) {
	let buffer = '';
	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const raw of lines) {
			const line = raw.trim();
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (!payload || payload === '[DONE]') continue;
			try {
				yield JSON.parse(payload);
			} catch {
				// skip malformed event
			}
		}
	}
}

export async function runTurn(skill, ctx) {
	const startTime = Date.now();
	ctx.outbox = ctx.outbox ?? [];
	ctx.drafts = ctx.drafts ?? [];

	// preCheck — optional skill-defined short-circuit before any LLM call.
	if (typeof skill.preCheck === 'function') {
		const early = await skill.preCheck(ctx);
		if (early) {
			await appendTurnLog({
				ts: new Date().toISOString(),
				skill: skill.name,
				kind: 'precheck_short_circuit',
				outbox_count: ctx.outbox.length,
				drafts_count: ctx.drafts.length,
				duration_ms: Date.now() - startTime
			});
			return early;
		}
	}

	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	const userMessages = await skill.buildContext(ctx);
	const toolDefs = toOpenAIToolDefs(skill.tools);
	const toolByName = new Map((skill.tools ?? []).map((t) => [t.name, t]));

	const working = [...userMessages];
	const toolCallsLog = [];
	const maxIterations = skill.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	let failure = null;
	let endTurn = false;
	let lastIter = 0;

	iter: for (let loop = 0; loop < maxIterations; loop++) {
		lastIter = loop + 1;

		// Recompute system prompt each iteration — skill.taskPrompt may be
		// dynamic (e.g., stage-aware). identityPrompt is invariant.
		const taskPromptValue =
			typeof skill.taskPrompt === 'function'
				? await skill.taskPrompt(ctx)
				: (skill.taskPrompt ?? '');
		const systemContent = taskPromptValue
			? `${identityPrompt}\n\n${taskPromptValue}`
			: identityPrompt;
		const messages = [{ role: 'system', content: systemContent }, ...working];

		let response;
		try {
			response = await fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					model: skill.model,
					messages,
					...(toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' } : {}),
					stream: true,
					...(skill.maxTokens ? { max_tokens: skill.maxTokens } : {})
				})
			});
		} catch (err) {
			failure = { stage: 'openai_request', error: err.message };
			break iter;
		}

		if (!response.ok) {
			const errText = await response.text().catch(() => '');
			failure = { stage: 'openai_response', status: response.status, error: errText };
			break iter;
		}
		if (!response.body) {
			failure = { stage: 'openai_response', error: 'empty body' };
			break iter;
		}

		// Streamed parse + inline tool dispatch as args complete.
		const calls = {};
		let plainContent = '';
		let dispatchedThrough = -1;

		const dispatchUpTo = async (maxIdx) => {
			for (let i = dispatchedThrough + 1; i <= maxIdx; i++) {
				const c = calls[i];
				if (!c || !c.name) continue;
				let parsed = {};
				try {
					parsed = JSON.parse(c.args || '{}');
				} catch {
					// keep empty
				}
				c.parsedArgs = parsed;
				const tool = toolByName.get(c.name);
				let result;
				if (!tool) {
					result = { error: `unknown tool: ${c.name}` };
				} else {
					try {
						result = await tool.run(parsed, ctx);
					} catch (err) {
						result = { error: err.message };
						failure = failure ?? { stage: 'tool', tool: c.name, error: err.message };
					}
				}
				c.result = result ?? {};
				toolCallsLog.push({ name: c.name, args: parsed, result: c.result });
				if (typeof ctx.onEvent === 'function') {
					// Generic tool_call event for logs. Transports may ignore it.
					await ctx.onEvent({ type: 'tool_call', name: c.name, args: parsed, result: c.result });
				}
				if (c.result?.endTurn) endTurn = true;
				dispatchedThrough = i;
			}
		};

		try {
			for await (const event of parseSSEStream(response)) {
				const choice = event.choices?.[0];
				if (!choice) continue;
				const delta = choice.delta ?? {};
				if (delta.content) plainContent += delta.content;
				if (Array.isArray(delta.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index;
						if (idx === undefined) continue;
						if (!calls[idx]) calls[idx] = { id: '', name: '', args: '' };
						if (tc.id) calls[idx].id = tc.id;
						if (tc.function?.name) calls[idx].name = tc.function.name;
						if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
						// New index = previous index's args are complete → dispatch now,
						// so the transport (live mode) can act on each call as it arrives
						// rather than waiting for the whole response.
						if (idx - 1 > dispatchedThrough) await dispatchUpTo(idx - 1);
					}
				}
			}
		} catch (err) {
			failure = failure ?? { stage: 'openai_stream', error: err.message };
			break iter;
		}

		// Flush any remaining tool calls after stream completes.
		const indices = Object.keys(calls)
			.map(Number)
			.sort((a, b) => a - b);
		const maxIdx = indices.length ? indices[indices.length - 1] : -1;
		if (maxIdx >= 0) await dispatchUpTo(maxIdx);

		const orderedCalls = indices.map((i) => calls[i]).filter((c) => c.name);

		if (orderedCalls.length > 0) {
			// Build the assistant content from plain content + any tool results
			// that opted into assistantContent (generic mechanism — orchestrator
			// never names a specific tool).
			const spoken = orderedCalls
				.map((c) => c.result?.assistantContent)
				.filter((s) => typeof s === 'string' && s.length > 0)
				.join('\n');
			const merged = [plainContent.trim(), spoken].filter(Boolean).join('\n');

			working.push({
				role: 'assistant',
				content: merged || null,
				tool_calls: orderedCalls.map((c) => ({
					id: c.id,
					type: 'function',
					function: { name: c.name, arguments: c.args || '{}' }
				}))
			});
			for (const c of orderedCalls) {
				// Strip orchestration-only fields before showing the model.
				const { assistantContent: _ac, endTurn: _et, ...modelVisibleResult } = c.result ?? {};
				working.push({
					tool_call_id: c.id,
					role: 'tool',
					content: JSON.stringify(modelVisibleResult)
				});
			}

			if (endTurn) break iter;
			if (failure) break iter;
			continue iter;
		}

		// No tool calls — model returned plain content (or nothing). For live
		// transports (ctx.onEvent set), emit it as a message so the user still
		// sees something. For draft transports, it's dropped — drafts must
		// come through send_text.
		if (plainContent.trim()) {
			const text = plainContent.trim();
			if (ctx.outbox.length === 0 && typeof ctx.onEvent === 'function') {
				await ctx.onEvent({ type: 'message', content: text });
				ctx.outbox.push(text);
			}
		}
		break iter;
	}

	if (!endTurn && lastIter === maxIterations && !failure) {
		// Hit the iteration cap. Only flag as a failure if the loop didn't
		// produce anything — otherwise we got drafts/messages and the model
		// just kept going for no useful reason. The bundle is still usable.
		if (ctx.outbox.length === 0 && ctx.drafts.length === 0) {
			failure = { stage: 'max_iterations', maxIterations };
		}
	}

	// Post-loop commit hook (e.g., demo persists assistant turn to history).
	if (typeof skill.commit === 'function') {
		try {
			await skill.commit(ctx);
		} catch (err) {
			failure = failure ?? { stage: 'commit', error: err.message };
		}
	}

	const result = {
		messages: [...ctx.outbox],
		drafts: [...ctx.drafts],
		toolCalls: toolCallsLog,
		failure
	};

	await appendTurnLog({
		ts: new Date().toISOString(),
		skill: skill.name,
		model: skill.model,
		kind: failure ? 'failure' : 'completed',
		iterations: lastIter,
		tool_calls: toolCallsLog.map((t) => ({
			name: t.name,
			ok: !t.result?.error,
			error: t.result?.error
		})),
		outbox_count: ctx.outbox.length,
		drafts_count: ctx.drafts.length,
		failure,
		duration_ms: Date.now() - startTime
	});

	return result;
}
