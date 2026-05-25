#!/usr/bin/env node
// Live test for the incoming_user_message event against real Supabase + OpenAI. Synthesizes
// one PM reply, runs runTurn(event, ctx), then polls observations/beliefs for
// the workspace to see what landed. Use this to sanity-check that learning
// actually fires end-to-end before deploying to the Mac mini.
//
// NOT under BEDROCK_EVAL_MODE — real writes happen. Default workspace is
// TEST so prod isn't polluted with experiments. Pass --workspace=prod
// explicitly when you want to test against the real workspace.
//
//   node agent/scripts/chat-live-test.mjs --text='always use Yonic for plumbing at Hub Champaign'
//   node agent/scripts/chat-live-test.mjs --text='no send Luigi instead' --workspace=test
//
// Cost: ~$0.02–0.10 per call (chat-skill LLM + embed + belief-former LLM).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(AGENT_ROOT, '..');

// Redirect file-state writes to a temp dir so we don't pollute drafts.json etc.
const SCRATCH = path.join(os.tmpdir(), `bedrock-chat-live-${process.pid}-${Date.now()}`);
const STATE_DIR = path.join(SCRATCH, 'state');
await fs.mkdir(STATE_DIR, { recursive: true });
process.env.BEDROCK_STATE_DIR = STATE_DIR;
// Prime an empty sent-log so recentSentForChat doesn't blow up looking for
// a file. We pass a non-existent chat_guid below, so the result is empty
// either way.
await fs.writeFile(path.join(STATE_DIR, 'sent-log.json'), '[]');

// Explicitly NOT in eval mode — real Supabase + OpenAI calls.
delete process.env.BEDROCK_EVAL_MODE;

async function loadDotEnv(p) {
	try {
		const raw = await fs.readFile(p, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith('#')) continue;
			const i = t.indexOf('=');
			if (i <= 0) continue;
			const k = t.slice(0, i).trim();
			let v = t.slice(i + 1).trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
				v = v.slice(1, -1);
			}
			if (!(k in process.env)) process.env[k] = v;
		}
	} catch {}
}
await loadDotEnv(path.join(REPO_ROOT, '.env'));
await loadDotEnv(path.join(AGENT_ROOT, '.env'));

if (!process.env.OPENAI_API_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
	console.error('env not loaded — symlink .env from main repo first');
	process.exit(2);
}

const WORKSPACE_LABELS = {
	prod: '2e4373a0-40b8-42c2-a873-b08c99dbf76a',
	test: '40d675ba-4dec-47dd-9222-79c0345c493f'
};

const args = process.argv.slice(2);
function arg(name) {
	for (const a of args) {
		if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
		if (a === `--${name}`) return true;
	}
	return null;
}

const text = arg('text');
const wsArg = arg('workspace') ?? 'test';
if (!text) {
	console.error('usage: node agent/scripts/chat-live-test.mjs --text="..." [--workspace=test|prod]');
	process.exit(2);
}
const workspace_id = WORKSPACE_LABELS[wsArg] ?? wsArg;

const { runTurn } = await import('../core/orchestrator.mjs');
const memory = await import('../core/memory.mjs');

// Snapshot beliefs BEFORE so we can diff.
const beliefsBefore = await memory.listBeliefs(workspace_id, { limit: 500 });
const obsCountBefore = (await memory.listObservations(workspace_id, { limit: 500 })).length;

const ctx = {
	chat_guid: 'live-test-no-real-chat', // fake — recentSentForChat returns []
	workspace_id,
	workspace_label: wsArg,
	text,
	sendMode: 'live',
	isPmHandle: false,
	onEvent: (ev) => {
		if (ev.type === 'tool_call') {
			console.log(`  · ${ev.name}(${JSON.stringify(ev.args ?? {}).slice(0, 140)})`);
		} else if (ev.type === 'message') {
			console.log(`  → would send: "${ev.content}"`);
		}
	}
};

console.log(`\nworkspace : ${wsArg} (${workspace_id})`);
console.log(`text      : "${text}"`);
console.log(`beliefs before: ${beliefsBefore.length} | observations before: ${obsCountBefore}\n`);
console.log(`▷ running incoming_user_message event...`);

const event = {
	type: 'incoming_user_message',
	payload: { text, chat_guid: ctx.chat_guid, sender_handle: null, msg_guid: null }
};
const result = await runTurn(event, ctx);
const toolNames = (result.toolCalls ?? []).map((t) => t.name);
console.log(`\nturn complete. tool calls: ${JSON.stringify(toolNames)}`);

// The belief-former is fire-and-forget; give it a moment to finish.
console.log(`waiting 6s for belief-former...`);
await new Promise((r) => setTimeout(r, 6000));

const beliefsAfter = await memory.listBeliefs(workspace_id, { limit: 500 });
const obsAfter = await memory.listObservations(workspace_id, { limit: 500 });

console.log(`\nobservations: ${obsCountBefore} → ${obsAfter.length}`);
console.log(`beliefs:      ${beliefsBefore.length} → ${beliefsAfter.length}\n`);

const newObs = obsAfter.slice(0, obsAfter.length - obsCountBefore);
if (newObs.length) {
	console.log(`new observations:`);
	for (const o of newObs) {
		console.log(`  [${o.id.slice(0, 8)}] sal=${o.salience.toFixed(2)}  ${o.summary}`);
	}
}

const byId = new Map(beliefsBefore.map((b) => [b.id, b]));
const changed = [];
const newBeliefs = [];
for (const b of beliefsAfter) {
	if (!byId.has(b.id)) {
		newBeliefs.push(b);
	} else {
		const prev = byId.get(b.id);
		if (Math.abs(prev.confidence - b.confidence) > 0.001) {
			changed.push({ before: prev, after: b });
		}
	}
}

if (newBeliefs.length) {
	console.log(`\nnew beliefs:`);
	for (const b of newBeliefs) {
		console.log(`  [${b.id.slice(0, 8)}] conf=${b.confidence.toFixed(2)} ${b.explicitness} by ${b.created_by}`);
		console.log(`            ${b.claim}`);
		console.log(`            scope: ${JSON.stringify(b.scope)}`);
	}
}
if (changed.length) {
	console.log(`\nbelief confidence changes:`);
	for (const { before, after } of changed) {
		const arrow = after.confidence > before.confidence ? '↑' : '↓';
		console.log(
			`  [${after.id.slice(0, 8)}] ${before.confidence.toFixed(2)} ${arrow} ${after.confidence.toFixed(2)}  ${after.claim.slice(0, 70)}`
		);
	}
}
if (!newObs.length && !newBeliefs.length && !changed.length) {
	console.log(`\nno memory changes — model did not call write_memory, or belief-former classified as noop.`);
}

console.log(`\nOpen the Memory tab to see the graph: http://127.0.0.1:7879/  (switch to ${wsArg} workspace)`);
