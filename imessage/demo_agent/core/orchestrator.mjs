// Orchestrator: streaming, one runTurn per user message.
// Emits events as they happen so the transport can show live UI:
//   {type:'read'}                                 user message acknowledged
//   {type:'typing'}                               about to call the model
//   {type:'message', content}                     a send_text result, in order
//   {type:'tool_call', name, args, result}        any non-send_text tool fired
//
// Tool calls are dispatched inline as the stream produces them. send_text
// results are emitted as 'message' events as soon as their args parse.

import { buildSystemPrompt, OPENER_MESSAGES } from './prompts.mjs';
import { TOOL_DEFS, executeTool } from './tools.mjs';
import * as memory from './memory.mjs';

const OPENER_TYPING_DELAY_MS = 600;
const OPENER_BETWEEN_MS = 700;
const MESSAGE_GAP_MS = 700;       // pause between consecutive bot messages within one iteration

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-2026-03-05';
const MAX_TOOL_LOOPS = 8;

// In-memory conversation log per handle: [{role: 'user'|'assistant', content}]
const conversations = new Map();

export function getConversation(handle) {
	return conversations.get(handle) ?? [];
}

export function resetConversation(handle) {
	conversations.delete(handle);
}

export async function runTurn(handle, userMessage, opts = {}) {
	const onEvent = opts.onEvent ?? (() => {});
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	await onEvent({ type: 'read' });

	const existing = conversations.get(handle) ?? [];
	const isFirstTurn = existing.length === 0;
	const history = existing;
	history.push({ role: 'user', content: userMessage });

	if (isFirstTurn) {
		// Canned opener — consistent intro + cta, no model call.
		for (let i = 0; i < OPENER_MESSAGES.length; i++) {
			await onEvent({ type: 'typing' });
			await sleep(OPENER_TYPING_DELAY_MS);
			await onEvent({ type: 'message', content: OPENER_MESSAGES[i] });
			if (i < OPENER_MESSAGES.length - 1) await sleep(OPENER_BETWEEN_MS);
		}
		const finalText = OPENER_MESSAGES.join('\n');
		history.push({ role: 'assistant', content: finalText });
		conversations.set(handle, history);
		return { messages: [...OPENER_MESSAGES], toolCalls: [] };
	}

	const working = [
		{ role: 'system', content: '' }, // filled in per loop iteration
		...history.map(({ role, content }) => ({ role, content })),
	];

	const outbox = [];
	const toolCallsLog = [];
	// opts.ctx is merged in so callers (e.g. imessage.mjs) can attach
	// per-turn capabilities like a `react` callback bound to the incoming
	// message GUID, without the orchestrator needing to know about iMessage.
	const ctx = { handle, outbox, ...(opts.ctx || {}) };

	for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
		// Refresh the system prompt each iteration so a mid-turn set_demo_stage applies right away.
		const stage = (await memory.getProfile(handle, 'system/stage')) || 'intro';
		working[0] = { role: 'system', content: buildSystemPrompt(stage) };

		await onEvent({ type: 'typing' });

		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: OPENAI_MODEL,
				messages: working,
				tools: TOOL_DEFS,
				tool_choice: 'auto',
				stream: true,
			}),
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`OpenAI ${response.status}: ${errText}`);
		}
		if (!response.body) throw new Error('OpenAI returned no body');

		const decoder = new TextDecoder();
		let buffer = '';
		const calls = {};            // index -> {id, name, args, parsedArgs, result}
		let dispatchedThrough = -1;
		let plainContent = '';
		let messagesThisIter = 0;    // counts bot messages emitted in this iteration

		const dispatchUpTo = async (maxIdx) => {
			for (let i = dispatchedThrough + 1; i <= maxIdx; i++) {
				const c = calls[i];
				if (!c || !c.name) continue;
				let parsed = {};
				try { parsed = JSON.parse(c.args || '{}'); } catch { /* keep empty */ }
				c.parsedArgs = parsed;
				c.result = await executeTool(c.name, parsed, ctx);
				toolCallsLog.push({ name: c.name, args: parsed, result: c.result });
				if (c.name === 'send_text') {
					const text = String(parsed.content ?? '').trim();
					for (const part of text.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
						// Pace consecutive messages: typing indicator + gap before each
						// non-first message in this iteration. Between iterations the
						// API call latency itself provides the pause, so first message
						// of an iteration goes through immediately.
						if (messagesThisIter > 0) {
							await onEvent({ type: 'typing' });
							await sleep(MESSAGE_GAP_MS);
						}
						await onEvent({ type: 'message', content: part });
						messagesThisIter++;
					}
				} else {
					await onEvent({ type: 'tool_call', name: c.name, args: parsed, result: c.result });
				}
				dispatchedThrough = i;
			}
		};

		for await (const chunk of response.body) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;
				let event;
				try { event = JSON.parse(payload); } catch { continue; }
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
						// A new index appearing means the previous one is done.
						if (idx - 1 > dispatchedThrough) await dispatchUpTo(idx - 1);
					}
				}
			}
		}

		// Stream done — flush any remaining tool calls.
		const indices = Object.keys(calls).map(Number).sort((a, b) => a - b);
		const maxIdx = indices.length ? indices[indices.length - 1] : -1;
		if (maxIdx >= 0) await dispatchUpTo(maxIdx);

		const orderedCalls = indices.map(i => calls[i]).filter(c => c.name);

		if (orderedCalls.length > 0) {
			// Mirror send_text contents into assistant.content so the model reads
			// its own prior speech as text, not just as opaque tool invocations.
			const spoken = orderedCalls
				.filter(c => c.name === 'send_text')
				.map(c => String(c.parsedArgs?.content ?? '').trim())
				.filter(Boolean)
				.join('\n');
			const merged = [plainContent.trim(), spoken].filter(Boolean).join('\n');
			// Feed assistant + tool results back so the model can continue.
			working.push({
				role: 'assistant',
				content: merged || null,
				tool_calls: orderedCalls.map(c => ({
					id: c.id,
					type: 'function',
					function: { name: c.name, arguments: c.args || '{}' },
				})),
			});
			for (const c of orderedCalls) {
				working.push({
					tool_call_id: c.id,
					role: 'tool',
					content: JSON.stringify(c.result ?? {}),
				});
			}
			// Loop back for another model call.
			continue;
		}

		// No tool calls this iteration — model produced final content (or nothing).
		if (plainContent.trim() && outbox.length === 0) {
			const text = plainContent.trim();
			outbox.push(text);
			await onEvent({ type: 'message', content: text });
		}
		break;
	}

	const finalText = outbox.join('\n');
	history.push({ role: 'assistant', content: finalText });
	conversations.set(handle, history);

	return { messages: outbox, toolCalls: toolCallsLog };
}
