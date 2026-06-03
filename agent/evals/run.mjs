#!/usr/bin/env node
// Eval runner. Iterates agent/evals/scenarios.mjs, runs each through the
// orchestrator with isolated state, checks expected against actual, prints
// a pass/fail summary.
//
// Usage:
//   node agent/evals/run.mjs                          # run all scenarios
//   node agent/evals/run.mjs --filter process_wo      # only scenarios whose name includes 'process_wo'
//   node agent/evals/run.mjs --filter "yes,vendor"    # comma-separated → match ANY substring
//   node agent/evals/run.mjs --skip "no_match,opener" # comma-separated → exclude matching names
//   node agent/evals/run.mjs --bail                   # stop at first failure
//
// Isolation:
//   - BEDROCK_STATE_DIR points at /tmp/bedrock-evals-<pid>/state — drafts,
//     sent-log, response-log, chat-log, turns.jsonl all redirected here.
//   - BEDROCK_DATA_DIR points at /tmp/bedrock-evals-<pid>/data — per-handle
//     memory (demo skill) redirected here.
//   - global.fetch is patched to intercept Supabase REST calls per scenario.
//     OpenAI calls pass through to the real API.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ─── Argv ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function parseListArg(flag) {
	const i = args.indexOf(flag);
	if (i < 0) return null;
	return args[i + 1]
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}
const filters = parseListArg('--filter'); // run if name includes ANY filter
const skips = parseListArg('--skip'); // skip if name includes ANY skip
const bail = args.includes('--bail');

// ─── Env: temp dirs FIRST, before any imports that read them ───────────────

const SCRATCH = path.join(os.tmpdir(), `bedrock-evals-${process.pid}-${Date.now()}`);
const STATE_DIR = path.join(SCRATCH, 'state');
const DATA_DIR = path.join(SCRATCH, 'data');
await fs.mkdir(STATE_DIR, { recursive: true });
await fs.mkdir(DATA_DIR, { recursive: true });
process.env.BEDROCK_STATE_DIR = STATE_DIR;
process.env.BEDROCK_DATA_DIR = DATA_DIR;
// Memory tools (write_memory, read_memory) check this and short-circuit
// instead of writing to live Supabase / firing the belief-former. The eval
// suite asserts tool-call behavior, not memory side effects. The dedicated
// memory scenarios still see the calls happen — they just don't persist.
process.env.BEDROCK_EVAL_MODE = '1';

// Load .env from repo root + agent/.
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
	} catch {
		/* optional */
	}
}
const HERE = path.dirname(new URL(import.meta.url).pathname);
const AGENT_ROOT = path.resolve(HERE, '..');
await loadDotEnv(path.resolve(AGENT_ROOT, '..', '.env'));
await loadDotEnv(path.resolve(AGENT_ROOT, '.env'));

if (!process.env.OPENAI_API_KEY) {
	console.error('OPENAI_API_KEY not set — checked repo root and agent/');
	process.exit(1);
}

// ─── Imports (after env is set) ────────────────────────────────────────────

const { scenarios } = await import('./scenarios.mjs');
const { runTurn } = await import('../core/orchestrator.mjs');
const { resetConversation, _setConversationForTest } = await import('../core/demo-state.mjs');
const memory = await import('../memory.mjs');
const { judge } = await import('./judge.mjs');

// Map legacy scenario.skill → AgentEvent for back-compat. New scenarios should
// declare scenario.event directly; this shim lets existing entries keep working
// while the suite migrates incrementally.
function deriveEvent(scenario) {
	if (scenario.event) return scenario.event;
	const c = scenario.ctx ?? {};
	if (scenario.skill === 'process_wo') {
		return {
			type: 'new_issue',
			payload: { issue: c.issue, candidate_vendors: c.candidate_vendors }
		};
	}
	if (scenario.skill === 'chat') {
		return {
			type: 'incoming_user_message',
			payload: {
				text: c.text,
				chat_guid: c.chat_guid,
				sender_handle: c.handle ?? null,
				msg_guid: null
			}
		};
	}
	if (scenario.skill === 'demo') {
		return {
			type: 'incoming_anon_message',
			payload: { text: c.text, handle: c.handle }
		};
	}
	throw new Error(
		`scenario "${scenario.name}" has no event and no recognized skill ("${scenario.skill}")`
	);
}

// ─── State setup / teardown per scenario ──────────────────────────────────

async function writeJson(file, value) {
	await fs.writeFile(path.join(STATE_DIR, file), JSON.stringify(value, null, 2));
}

async function resetState(scenario) {
	const setup = scenario.setup ?? {};
	await writeJson('drafts.json', setup.drafts ?? []);
	await writeJson('sent-log.json', setup.sent_log ?? []);
	await writeJson('chat-log.json', setup.chat_log ?? []);
	await writeJson('response-log.json', []);
	await writeJson('issues-cursor.json', {
		processedIds: {},
		lastCheckedAt: new Date().toISOString()
	});
	// Clear turns.jsonl
	try {
		await fs.unlink(path.join(STATE_DIR, 'turns.jsonl'));
	} catch {}

	// Demo skill memory seeding
	if (scenario.skill === 'demo' && setup.memory) {
		for (const [handle, mem] of Object.entries(setup.memory)) {
			// Wipe + reseed in temp DATA_DIR
			try {
				await memory.resetHandle(handle);
			} catch {}
			for (const [slug, value] of Object.entries(mem.profile ?? {})) {
				await memory.updateProfile(handle, slug, value);
			}
			for (const obs of mem.observations ?? []) {
				await memory.addObservation(handle, obs.content, obs.tags || []);
			}
			if (mem.conversation) {
				_setConversationForTest(handle, mem.conversation);
			} else {
				resetConversation(handle);
			}
		}
	} else if (scenario.skill === 'demo' && scenario.ctx?.handle) {
		// Default: clean slate for the test handle.
		try {
			await memory.resetHandle(scenario.ctx.handle);
		} catch {}
		resetConversation(scenario.ctx.handle);
	}
}

// ─── Supabase fetch interception ──────────────────────────────────────────

const realFetch = global.fetch;
let supabaseMock = {};
// Per-scenario vendor roster ({ id, name, phone? }[]) served for /rest/v1/vendors.
// Set from setup.supabase_vendors; [] for scenarios that don't care.
let supabaseVendors = [];

global.fetch = async (url, init) => {
	const urlStr = typeof url === 'string' ? url : (url?.toString?.() ?? '');
	if (urlStr.includes('/rest/v1/issues_v2')) {
		// Parse id=eq.<uuid> from the query string
		const m = urlStr.match(/id=eq\.([^&]+)/);
		if (m) {
			const id = decodeURIComponent(m[1]);
			const issue = supabaseMock[id];
			return new Response(JSON.stringify(issue ? [issue] : []), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
	}
	if (urlStr.includes('/rest/v1/vendors')) {
		// fetchWorkspaceVendors (workspace_id filter only) → whole roster.
		// fetchVendorByName (name=ilike.<x>) → roster rows matching that name,
		// honoring PostgREST's `*` wildcard so substring lookups resolve.
		const nameM = urlStr.match(/name=ilike\.([^&]+)/);
		let rows = supabaseVendors;
		if (nameM) {
			const needle = decodeURIComponent(nameM[1]).replace(/\*/g, '').toLowerCase();
			rows = supabaseVendors.filter((v) => v.name?.toLowerCase().includes(needle));
		}
		return new Response(JSON.stringify(rows), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}
	return realFetch(url, init);
};

// ─── Assertion helpers ─────────────────────────────────────────────────────

function setEqual(a, b) {
	const A = new Set(a);
	const B = new Set(b);
	if (A.size !== B.size) return false;
	for (const x of A) if (!B.has(x)) return false;
	return true;
}

function joinBodies(arr) {
	return (arr ?? []).map((x) => (typeof x === 'string' ? x : (x.body ?? ''))).join('\n');
}

async function checkExpected(scenario, result, ctx) {
	const exp = scenario.expected ?? {};
	const fails = [];

	// use_skill is orchestration mechanics, not behavior — it loads a skill
	// for the model to follow. Strip it from the actual tool sequence so
	// behavioral assertions stay clean. If a scenario specifically wants to
	// assert use_skill firing, it can opt in via expected.assert_use_skill.
	const allToolNames = (result.toolCalls ?? []).map((t) => t.name);
	const toolNames = allToolNames.filter((n) => n !== 'use_skill');

	if (exp.tool_calls) {
		if (JSON.stringify(toolNames) !== JSON.stringify(exp.tool_calls)) {
			fails.push(
				`tool_calls expected ${JSON.stringify(exp.tool_calls)}, got ${JSON.stringify(toolNames)}`
			);
		}
	}
	if (exp.tool_calls_set) {
		if (!setEqual(toolNames, exp.tool_calls_set)) {
			fails.push(
				`tool_calls_set expected ${JSON.stringify(exp.tool_calls_set)}, got ${JSON.stringify(toolNames)}`
			);
		}
	}
	if (exp.no_tools === true && toolNames.length > 0) {
		fails.push(`expected no tool calls, got ${JSON.stringify(toolNames)}`);
	}
	// tool_calls_set_includes: every name listed must appear; extras allowed.
	if (exp.tool_calls_set_includes) {
		const have = new Set(toolNames);
		const missing = exp.tool_calls_set_includes.filter((n) => !have.has(n));
		if (missing.length) {
			fails.push(
				`tool_calls_set_includes missing ${JSON.stringify(missing)}, got ${JSON.stringify(toolNames)}`
			);
		}
	}
	// tool_calls_excludes: none of the listed names may appear.
	if (exp.tool_calls_excludes) {
		const have = new Set(toolNames);
		const present = exp.tool_calls_excludes.filter((n) => have.has(n));
		if (present.length) {
			fails.push(
				`tool_calls_excludes saw forbidden ${JSON.stringify(present)}, got ${JSON.stringify(toolNames)}`
			);
		}
	}

	// tool_args: for each { toolName: {k: v} }, assert SOME call to that tool had
	// args matching all the listed key/values. Lets scenarios check what a tool
	// was called WITH (e.g. update_issue status), not just that it fired.
	if (exp.tool_args) {
		for (const [toolName, wantArgs] of Object.entries(exp.tool_args)) {
			const calls = (result.toolCalls ?? []).filter((t) => t.name === toolName);
			if (!calls.length) {
				fails.push(`tool_args: ${toolName} was not called`);
				continue;
			}
			const ok = calls.some((c) =>
				Object.entries(wantArgs).every(([k, v]) => (c.args?.[k] ?? null) === v)
			);
			if (!ok) {
				fails.push(
					`tool_args: no ${toolName} call matched ${JSON.stringify(wantArgs)}; got ${JSON.stringify(calls.map((c) => c.args))}`
				);
			}
		}
	}

	// drafts_count: combine ctx.drafts (F1 staged) + ctx.draftIds (F2 direct writes)
	const stagedDrafts = ctx.drafts ?? [];
	const directDraftIds = ctx.draftIds ?? [];
	const actualDraftCount = stagedDrafts.length + directDraftIds.length;
	if (exp.drafts_count !== undefined && actualDraftCount !== exp.drafts_count) {
		fails.push(`drafts_count expected ${exp.drafts_count}, got ${actualDraftCount}`);
	}

	// drafts_channels: read drafts.json to get the channels of directly-written drafts
	if (exp.drafts_channels) {
		const allDrafts = JSON.parse(await fs.readFile(path.join(STATE_DIR, 'drafts.json'), 'utf8'));
		const channels = allDrafts.map((d) => d.channel);
		if (!setEqual(channels, exp.drafts_channels)) {
			fails.push(
				`drafts_channels expected ${JSON.stringify(exp.drafts_channels)}, got ${JSON.stringify(channels)}`
			);
		}
	}

	// drafts_include: substrings in the joined draft bodies
	if (exp.drafts_include) {
		const stagedBody = joinBodies(stagedDrafts);
		const allDrafts = JSON.parse(await fs.readFile(path.join(STATE_DIR, 'drafts.json'), 'utf8'));
		const directBody = allDrafts.flatMap((d) => d.messages?.map((m) => m.body) ?? []).join('\n');
		const combined = stagedBody + '\n' + directBody;
		for (const needle of exp.drafts_include) {
			if (!combined.toLowerCase().includes(needle.toLowerCase())) {
				fails.push(`drafts_include expected substring ${JSON.stringify(needle)} not found`);
			}
		}
	}

	// drafts_excludes: substrings that must NOT appear in any draft body
	if (exp.drafts_excludes) {
		const stagedBody = joinBodies(stagedDrafts);
		const allDrafts = JSON.parse(await fs.readFile(path.join(STATE_DIR, 'drafts.json'), 'utf8'));
		const directBody = allDrafts.flatMap((d) => d.messages?.map((m) => m.body) ?? []).join('\n');
		const combined = (stagedBody + '\n' + directBody).toLowerCase();
		for (const needle of exp.drafts_excludes) {
			if (combined.includes(needle.toLowerCase())) {
				fails.push(`drafts_excludes substring ${JSON.stringify(needle)} unexpectedly present`);
			}
		}
	}

	if (exp.outbox_count !== undefined && (ctx.outbox?.length ?? 0) !== exp.outbox_count) {
		fails.push(`outbox_count expected ${exp.outbox_count}, got ${ctx.outbox?.length ?? 0}`);
	}

	if (exp.outbox_includes) {
		const joined = (ctx.outbox ?? []).join('\n').toLowerCase();
		for (const needle of exp.outbox_includes) {
			if (!joined.includes(needle.toLowerCase())) {
				fails.push(`outbox_includes expected substring ${JSON.stringify(needle)} not found`);
			}
		}
	}

	if (exp.failure_stage !== undefined) {
		const actualStage = result.failure?.stage ?? null;
		if (actualStage !== exp.failure_stage) {
			fails.push(
				`failure_stage expected ${JSON.stringify(exp.failure_stage)}, got ${JSON.stringify(actualStage)}`
			);
		}
	}

	if (exp.judge) {
		const target = exp.judge.target ?? 'all';
		let output;
		if (target === 'drafts') {
			const stagedBody = joinBodies(stagedDrafts);
			const allDrafts = JSON.parse(await fs.readFile(path.join(STATE_DIR, 'drafts.json'), 'utf8'));
			const directBody = allDrafts.flatMap((d) => d.messages?.map((m) => m.body) ?? []).join('\n');
			output = (stagedBody + '\n' + directBody).trim();
		} else if (target === 'outbox') {
			output = (ctx.outbox ?? []).join('\n');
		} else {
			output = JSON.stringify(
				{ outbox: ctx.outbox, drafts: stagedDrafts, toolCalls: toolNames },
				null,
				2
			);
		}
		const { pass, reason } = await judge({ output, criteria: exp.judge.criteria });
		if (!pass) fails.push(`judge: ${reason}`);
	}

	return fails;
}

// ─── Main loop ─────────────────────────────────────────────────────────────

const start = Date.now();
let pass = 0,
	fail = 0;
const failures = [];

for (const scenario of scenarios) {
	const lname = scenario.name.toLowerCase();
	if (filters && !filters.some((f) => lname.includes(f))) continue;
	if (skips && skips.some((s) => lname.includes(s))) continue;

	process.stdout.write(`▷ ${scenario.name} `);
	await resetState(scenario);
	supabaseMock = scenario.setup?.supabase ?? {};
	supabaseVendors = scenario.setup?.supabase_vendors ?? [];

	let event;
	try {
		event = deriveEvent(scenario);
	} catch (err) {
		console.log(`SKIP — ${err.message}`);
		continue;
	}

	const ctx = {
		...scenario.ctx,
		// Live events (incoming_anon_message) emit messages via onEvent → capture in outbox.
		onEvent: async (ev) => {
			// outbox is auto-populated by tool implementations; orchestrator emits
			// tool_call events which we ignore here.
		},
		// Default sendMode if not specified by the scenario.
		// new_issue AND incoming_user_message draft for human review — the
		// groupchat agent never auto-sends to the PM. Only the demo path
		// (incoming_anon_message) is live (the demo bot streams to the prospect).
		sendMode:
			scenario.ctx?.sendMode ??
			(event.type === 'new_issue' || event.type === 'incoming_user_message' ? 'draft' : 'live'),
		isPmHandle: scenario.ctx?.isPmHandle ?? false
	};

	let result,
		runError = null;
	try {
		result = await runTurn(event, ctx);
	} catch (err) {
		runError = err;
	}

	if (runError) {
		console.log(`FAIL — runTurn threw: ${runError.message}`);
		failures.push({ name: scenario.name, fails: [`runTurn threw: ${runError.message}`] });
		fail++;
		if (bail) break;
		continue;
	}

	let fails;
	try {
		fails = await checkExpected(scenario, result, ctx);
	} catch (err) {
		fails = [`checkExpected threw (likely judge/network): ${err.message}`];
	}
	if (fails.length === 0) {
		console.log('✓');
		pass++;
	} else {
		console.log('✗');
		for (const f of fails) console.log(`    · ${f}`);
		if (args.includes('--verbose') || args.includes('-v')) {
			for (const tc of result.toolCalls ?? []) {
				const a = JSON.stringify(tc.args ?? {});
				console.log(`    tool: ${tc.name}(${a.length > 200 ? a.slice(0, 200) + '...' : a})`);
			}
			if (ctx.outbox?.length) console.log(`    outbox: ${JSON.stringify(ctx.outbox)}`);
		}
		failures.push({ name: scenario.name, fails });
		fail++;
		if (bail) break;
	}
}

const dur = ((Date.now() - start) / 1000).toFixed(1);
console.log();
console.log(`━━━ ${pass}/${pass + fail} pass · ${dur}s ━━━`);
if (failures.length > 0) {
	console.log();
	console.log('Failures:');
	for (const f of failures) {
		console.log(`  ${f.name}`);
		for (const reason of f.fails) console.log(`    · ${reason}`);
	}
}

// Cleanup scratch dir (comment out to inspect after run)
const keep = args.includes('--keep');
if (!keep) {
	try {
		await fs.rm(SCRATCH, { recursive: true, force: true });
	} catch {}
} else {
	console.log(`scratch: ${SCRATCH}`);
}

process.exit(fail > 0 ? 1 : 0);
