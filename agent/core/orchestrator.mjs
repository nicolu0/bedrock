// THE orchestrator — the only place OpenAI is called.
//
//   runTurn(event, ctx)
//
// event = { type: 'new_issue' | 'incoming_user_message' | 'incoming_anon_message', payload: {...} }
// ctx   = transport hooks + per-turn state (handle, chat_guid, workspace_id,
//         workspace_label, onEvent, sendMode, outbox, drafts, ...)
//
// The router resolves event.type → { skill, model, hooks }. The orchestrator
// loads the SKILL.md, builds a stack of <system-reminder> blocks, splices any
// per-event history (demo) in front of the user message, then runs the LLM
// loop with the unified tool registry.
//
// Tools are NOT scoped per skill or per event. Every turn loads ALL_TOOLS from
// the registry. Skill prose can suggest which tools fit a phase, but it's
// guidance, not enforcement.
//
// Tool result conventions (generic — orchestrator never names a tool):
//   { ...result, assistantContent?: string, endTurn?: boolean }
//     assistantContent — concatenated into the assistant content of the
//       working messages so the model reads its own speech as text on the
//       next iteration. (send_text uses this; other tools normally don't.)
//     endTurn — break the loop after this tool runs. Used by tools that speak
//       the final word of a turn.
//
// Grep-test invariant: this file must contain zero references to specific
// skill names (process_work_order, demo) or specific tool names (send_text, etc.).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { identityPrompt } from './identity.mjs';
import { ALL_TOOLS } from '../tools/registry.mjs';
import { resolveEvent } from './router.mjs';
import { buildReminders, composeUserContent } from './reminders.mjs';
import { loadSkill } from './skills.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR =
	process.env.BEDROCK_STATE_DIR || path.join(__dirname, '..', 'state');
const TURNS_LOG_PATH = path.join(STATE_DIR, 'turns.jsonl');

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

export async function runTurn(event, ctx) {
	const startTime = Date.now();
	ctx.outbox = ctx.outbox ?? [];
	ctx.drafts = ctx.drafts ?? [];

	const resolution = resolveEvent(event);

	// Identifying fields stamped on every turn-log row for this turn, so the
	// Turns UI can link a turn back to its session / work order. ctx carries
	// handle/chat_guid/workspace/session_id (set by the trigger that built it);
	// issue_id rides on the new_issue payload. Anything absent for an event
	// type is null (e.g. new_issue has no handle; incoming_user_message has no issue_id).
	const turnIdentity = {
		turn_id: `turn_${randomBytes(8).toString('hex')}`,
		workspace_id: ctx.workspace_id ?? null,
		workspace_label: ctx.workspace_label ?? null,
		handle: ctx.handle ?? null,
		chat_guid: ctx.chat_guid ?? null,
		session_id: ctx.session_id ?? null,
		issue_id: event.payload?.issue?.id ?? null
	};

	// preCheck — optional per-event short-circuit before any LLM call.
	if (typeof resolution.preCheck === 'function') {
		const early = await resolution.preCheck(event, ctx);
		if (early) {
			await appendTurnLog({
				ts: new Date().toISOString(),
				event: event.type,
				skill: resolution.skill,
				...turnIdentity,
				kind: 'precheck_short_circuit',
				trigger: { event: event.type, user_content: null, payload: event.payload ?? null },
				steps: [],
				outbox_count: ctx.outbox.length,
				drafts_count: ctx.drafts.length,
				duration_ms: Date.now() - startTime
			});
			return early;
		}
	}

	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	// Build the user message for this turn: reminders + (optional) verbatim
	// trigger text. Per-event history (demo) is spliced in front. The active
	// skill (if preloaded) rides in the system prompt (see system message
	// assembly below); otherwise the model loads it via use_skill mid-turn.
	const reminderBlocks = await buildReminders(event, ctx, resolution.skill);
	const userContent = composeUserContent(event, reminderBlocks);

	// Per-event conversation history (prior turns) spliced in front of the user
	// message. Computed up front so the turn trace can show exactly what context
	// the model got — history was previously invisible in the trace.
	const priorHistory = (typeof resolution.buildHistory === 'function')
		? await resolution.buildHistory(event, ctx)
		: [];

	// Full trigger record for the turn trace: prior-turn history + the literal
	// prompt the model saw (reminders + verbatim trigger text) + the raw event
	// payload — i.e. everything that kicked this turn off. Stored verbatim.
	const trigger = {
		event: event.type,
		history: priorHistory,
		user_content: userContent,
		payload: event.payload ?? null
	};

	// Skill body loaded from <skill>/SKILL.md and concatenated with
	// identityPrompt to form the system message — but only when the event's
	// resolution opts into preload. For heterogeneous events (e.g. incoming_user_message),
	// resolution.skill is undefined; the system prompt is identity alone and
	// the model is expected to call use_skill if a workflow match is obvious.
	let systemContent = identityPrompt;
	if (resolution.skill) {
		const skill = await loadSkill(resolution.skill);
		systemContent = `${identityPrompt}\n\n${skill.body}`;
	}

	const userMessages = [
		...priorHistory,
		{ role: 'user', content: userContent }
	];

	const toolDefs = toOpenAIToolDefs(ALL_TOOLS);
	const toolByName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

	const working = [...userMessages];
	const toolCallsLog = [];
	// Per-iteration trace: each loop pass records the model's narration
	// (plainContent) and the full tool calls it fired (name + args + result).
	const steps = [];
	const maxIterations = resolution.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	let failure = null;
	let endTurn = false;
	let lastIter = 0;

	iter: for (let loop = 0; loop < maxIterations; loop++) {
		lastIter = loop + 1;

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
					model: resolution.model,
					messages,
					...(toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' } : {}),
					stream: true,
					// Eval-mode temperature: 0 so judge-based scenarios and tool-call
					// assertions are reproducible. Prod stays on the OpenAI default
					// for now — change cautiously, it affects every user-facing turn.
					...(process.env.BEDROCK_EVAL_MODE === '1' ? { temperature: 0 } : {}),
					...(resolution.maxTokens ? { max_completion_tokens: resolution.maxTokens } : {})
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
					await ctx.onEvent({ type: 'tool_call', name: c.name, args: parsed, result: c.result });
				}
				if (c.result?.endTurn) endTurn = true;
				dispatchedThrough = i;
			}
		};

		try {
			for await (const ev of parseSSEStream(response)) {
				const choice = ev.choices?.[0];
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
						// so the transport (live mode) can act on each call as it arrives.
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
				const { assistantContent: _ac, endTurn: _et, ...modelVisibleResult } = c.result ?? {};
				working.push({
					tool_call_id: c.id,
					role: 'tool',
					content: JSON.stringify(modelVisibleResult)
				});
			}

			steps.push({
				i: lastIter,
				reasoning: plainContent.trim() || null,
				tool_calls: orderedCalls.map((c) => ({
					name: c.name,
					args: c.parsedArgs ?? {},
					result: c.result ?? {},
					ok: !c.result?.error,
					error: c.result?.error ?? null
				}))
			});

			if (endTurn) break iter;
			if (failure) break iter;
			continue iter;
		}

		// No tool calls — model returned plain content (or nothing). Default:
		// drop it and warn. The only path to a real outbound message should be
		// through a tool (send_text, etc.) so tool-level safety guards stay the
		// single chokepoint.
		//
		// Opt-in: an event resolution may set allowPlainContentSend: true to
		// keep a safety-net fallback that emits plain content as a message
		// event (demo, process_work_order — prompts haven't been tightened to
		// always route through send_text). New event resolutions should NOT
		// opt in; tighten the prompt instead.
		let plainSent = false;
		if (plainContent.trim()) {
			const text = plainContent.trim();
			if (
				resolution.allowPlainContentSend &&
				ctx.outbox.length === 0 &&
				typeof ctx.onEvent === 'function'
			) {
				await ctx.onEvent({ type: 'message', content: text });
				ctx.outbox.push(text);
				plainSent = true;
			} else {
				const preview = text.slice(0, 120);
				console.warn(
					`[orchestrator] dropped plain content from event="${event.type}" skill="${resolution.skill ?? '(none preloaded)'}" (no tool call): "${preview}${text.length > 120 ? '…' : ''}"`
				);
			}
		}
		// Final pass with no tool calls: record the narration and whether it was
		// emitted as a message or dropped (the model spoke without routing to a tool).
		steps.push({
			i: lastIter,
			reasoning: plainContent.trim() || null,
			tool_calls: [],
			dropped_plain_content: !!(plainContent.trim() && !plainSent)
		});
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
	if (typeof resolution.commit === 'function') {
		try {
			await resolution.commit(event, ctx);
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
		event: event.type,
		skill: resolution.skill,
		model: resolution.model,
		...turnIdentity,
		kind: failure ? 'failure' : 'completed',
		iterations: lastIter,
		tool_calls: toolCallsLog.map((t) => ({
			name: t.name,
			ok: !t.result?.error,
			error: t.result?.error
		})),
		trigger,
		steps,
		outbox_count: ctx.outbox.length,
		drafts_count: ctx.drafts.length,
		failure,
		duration_ms: Date.now() - startTime
	});

	return result;
}
