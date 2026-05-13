#!/usr/bin/env node
// CLI testbed for the agent. No iMessage in the loop.
//   node agent/cli.mjs [handle]
// Commands:
//   :state            print profile + recent observations
//   :reset            wipe this handle's memory + conversation
//   :replay <file>    feed each non-empty line as a user turn
//   :exit             quit

import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTurn } from './core/orchestrator.mjs';
import { demoSkill, resetConversation, getConversation } from './skills/demo.mjs';
import * as memory from './memory.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

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
	} catch { /* optional */ }
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const blue = (s) => `\x1b[34m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const CLEAR_LINE = '\r\x1b[2K';

const handle = process.argv[2] || '+15555550100';

await loadDotEnv(path.join(SCRIPT_DIR, '..', '.env'));
await loadDotEnv(path.join(SCRIPT_DIR, '.env'));

if (!process.env.OPENAI_API_KEY) {
	console.log(red('OPENAI_API_KEY not set — checked .env in repo root and agent/'));
	process.exit(1);
}

console.log(dim(`bedrock agent cli  handle=${handle}  model=${process.env.OPENAI_MODEL || 'gpt-5.4-2026-03-05'}`));
console.log(dim(`commands: :state  :reset  :replay <file>  :exit`));

let typingShown = false;
function clearTyping() {
	if (typingShown) {
		process.stdout.write(CLEAR_LINE);
		typingShown = false;
	}
}
function showTyping() {
	process.stdout.write(CLEAR_LINE + dim('(typing...)'));
	typingShown = true;
}

function onEvent(ev) {
	if (ev.type === 'read') {
		console.log(dim('(read)'));
	} else if (ev.type === 'typing') {
		showTyping();
	} else if (ev.type === 'message') {
		clearTyping();
		console.log(blue('bot> ') + ev.content);
	} else if (ev.type === 'tool_call') {
		clearTyping();
		const args = JSON.stringify(ev.args ?? {});
		const summary = args.length > 80 ? args.slice(0, 77) + '...' : args;
		console.log(dim(`  · ${ev.name}(${summary})`));
	}
}

async function turnAndPrint(line) {
	try {
		await runTurn(demoSkill, {
			handle,
			text: line,
			onEvent,
			sendMode: 'live',
			isPmHandle: false
		});
		clearTyping();
	} catch (e) {
		clearTyping();
		console.log(red(`error: ${e.message}`));
	}
}

async function printState() {
	const profile = await memory.getProfile(handle);
	const obs = await memory.listObservations(handle, 20);
	console.log(dim('— profile —'));
	const slugs = Object.keys(profile);
	if (slugs.length === 0) console.log(dim('  (empty)'));
	for (const k of slugs) console.log(`  ${k}: ${profile[k]}`);
	console.log(dim('— last 20 observations —'));
	if (obs.length === 0) console.log(dim('  (none)'));
	for (const o of obs) {
		const tags = o.tags?.length ? '  [' + o.tags.join(',') + ']' : '';
		console.log(`  ${o.ts.slice(11, 19)}  ${o.content}${tags}`);
	}
	const conv = getConversation(handle);
	console.log(dim(`— conversation: ${conv.length} turns —`));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = () => new Promise(r => rl.question(green('you> '), r));

while (true) {
	let line;
	try { line = (await ask()).trim(); }
	catch { break; }
	if (!line) continue;

	if (line === ':exit' || line === ':quit') break;

	if (line === ':state') {
		await printState();
		continue;
	}
	if (line === ':reset') {
		await memory.resetHandle(handle);
		resetConversation(handle);
		console.log(dim('reset.'));
		continue;
	}
	if (line.startsWith(':replay ')) {
		const file = line.slice(8).trim();
		try {
			const raw = await fs.readFile(file, 'utf8');
			for (const tline of raw.split(/\r?\n/)) {
				const t = tline.trim();
				if (!t || t.startsWith('#')) continue;
				console.log(green('you> ') + t);
				await turnAndPrint(t);
			}
		} catch (e) {
			console.log(red(`replay error: ${e.message}`));
		}
		continue;
	}

	await turnAndPrint(line);
}

rl.close();
