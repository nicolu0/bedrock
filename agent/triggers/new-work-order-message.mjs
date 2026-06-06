// Dedicated proactive new-work-order intake.
//
// This replaces the old new_issue → runTurn path only. Chat/demo still use the
// main orchestrator loop. This module owns AppFolio enrichment, memory recall,
// one structured LLM decision, issue patching, queueing, and turn visibility.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { WORKSPACES } from '../core/workspaces.mjs';
import { fetchWorkspaceVendors, patchIssue, supabaseEnv } from '../core/supabase.mjs';
import { shortenVendorName } from '../core/names.mjs';
import { readMemory } from '../tools/read_memory.mjs';
import { enqueuePmReviewDraft } from '../core/draft-queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.BEDROCK_STATE_DIR || path.join(__dirname, '..', 'state');
const TURNS_LOG_PATH = path.join(STATE_DIR, 'turns.jsonl');
const MODEL =
	process.env.NEW_WORK_ORDER_MODEL ||
	process.env.WORK_ORDERS_MODEL ||
	process.env.OPENAI_MODEL ||
	'gpt-5.4-2026-03-05';

function supabaseHeaders() {
	const { key } = supabaseEnv();
	return {
		apikey: key,
		Authorization: `Bearer ${key}`,
		'Content-Type': 'application/json',
		Accept: 'application/json'
	};
}

async function appendTurnLog(entry) {
	try {
		await fs.appendFile(TURNS_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
	} catch {
		// Observability must never make intake fail harder.
	}
}

function nowIso() {
	return new Date().toISOString();
}

function newTurnId() {
	return `turn_${randomBytes(8).toString('hex')}`;
}

function parseAppfolioEmailBody(body) {
	if (!body) return null;
	const text = String(body).replace(/\r/g, '');
	const jobMatch = text.match(/Job Description\s*\n+([\s\S]*?)\n+\s*Issue Descriptor:/i);
	const descMatch = text.match(
		/Issue Descriptor:\s*\n+([\s\S]*?)\n+\s*(?:Issue Details|Permission to Enter:|Resident Name:)/i
	);
	const job = jobMatch?.[1]?.replace(/\s+/g, ' ').trim() || null;
	const descriptor = descMatch?.[1]?.replace(/\s+/g, ' ').trim() || null;
	if (job && descriptor) return `${descriptor} - ${job}`;
	return job || descriptor || null;
}

async function fetchIssueRow(issue_id) {
	const { url } = supabaseEnv();
	const params = new URLSearchParams({
		select:
			'id,workspace_id,appfolio_srn,description,property_id,tenant_id,unit_id,name,urgent,created_at,vendor_id,' +
			'tenant:tenants!tenant_id(id,name),' +
			'property:properties!property_id(id,name,appfolio_property_id),' +
			'unit:units!unit_id(id,name),' +
			'vendor:vendors!vendor_id(id,name)',
		id: `eq.${issue_id}`,
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/issues_v2?${params}`, { headers: supabaseHeaders() });
	if (!res.ok) throw new Error(`fetchIssueRow ${res.status}: ${await res.text()}`);
	const rows = await res.json();
	return rows[0] ?? null;
}

async function fetchUnit(unit_id) {
	if (!unit_id) return null;
	const { url } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,name',
		id: `eq.${unit_id}`,
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/units?${params}`, { headers: supabaseHeaders() });
	if (!res.ok) throw new Error(`fetchUnit ${res.status}: ${await res.text()}`);
	const rows = await res.json();
	return rows[0] ?? null;
}

async function fetchUnitByAppfolioId({ property_id, appfolio_unit_id }) {
	const { url } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,name',
		property_id: `eq.${property_id}`,
		appfolio_unit_id: `eq.${appfolio_unit_id}`,
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/units?${params}`, { headers: supabaseHeaders() });
	if (!res.ok) throw new Error(`fetchUnitByAppfolioId ${res.status}: ${await res.text()}`);
	const rows = await res.json();
	return rows[0] ?? null;
}

function appfolioCreds() {
	const id = process.env.APPFOLIO_CLIENT_ID;
	const secret = process.env.APPFOLIO_CLIENT_SECRET;
	const vhost = process.env.APPFOLIO_VHOST;
	if (!id || !secret || !vhost) throw new Error('APPFOLIO_CLIENT_ID/SECRET/VHOST not set');
	return { id, secret, vhost };
}

function isoDate(d) {
	return d.toISOString().slice(0, 10);
}

async function fetchAppfolioWorkOrder({ appfolio_property_id, srn }) {
	const { id, secret, vhost } = appfolioCreds();
	const baseSrn = String(srn).split('-')[0];
	const today = new Date();
	const fromDate = new Date(today);
	fromDate.setDate(fromDate.getDate() - 3);
	const toDate = new Date(today);
	toDate.setDate(toDate.getDate() + 1);
	const body = {
		property_visibility: 'active',
		property: { property_id: appfolio_property_id },
		work_order_statuses: ['0', '1', '2', '9', '3', '6', '8', '12', '4', '5', '7'],
		status_date: '0',
		status_date_range_from: isoDate(fromDate),
		status_date_range_to: isoDate(toDate),
		columns: [
			'work_order_id',
			'service_request_number',
			'property_id',
			'unit_id',
			'job_description',
			'service_request_description',
			'requesting_tenant'
		]
	};

	const auth = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
	const rows = [];
	let nextUrl = `https://${vhost}/api/v2/reports/work_order.json`;
	let isFirst = true;
	while (nextUrl) {
		const u = new URL(nextUrl);
		u.username = u.password = '';
		let res = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			res = await fetch(u, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: auth },
				body: isFirst ? JSON.stringify(body) : JSON.stringify({})
			});
			if (res.status !== 429) break;
			const retryAfter = Math.min(Number(res.headers.get('retry-after') ?? attempt * 5), 15);
			await new Promise((r) => setTimeout(r, retryAfter * 1000 + Math.floor(Math.random() * 2000)));
		}
		if (!res || !res.ok) {
			const text = (await res?.text()) ?? '';
			throw new Error(`AppFolio work_order ${res?.status}: ${text.slice(0, 200)}`);
		}
		const json = await res.json();
		if (Array.isArray(json)) {
			rows.push(...json);
			break;
		}
		rows.push(...(json.results ?? []));
		nextUrl = json.next_page_url ?? null;
		isFirst = false;
	}
	return rows.find((r) => String(r.service_request_number) === baseSrn) ?? null;
}

async function enrichFromAppfolio(issue, workspace) {
	let unitId = issue.unit_id ?? null;
	let unit = issue.unit ?? null;
	let description = null;
	const details = { source: 'none', appfolio_hit: false };

	if (
		workspace.appfolioApi === true &&
		issue.property?.appfolio_property_id &&
		issue.appfolio_srn
	) {
		try {
			const wo = await fetchAppfolioWorkOrder({
				appfolio_property_id: issue.property.appfolio_property_id,
				srn: issue.appfolio_srn
			});
			if (wo) {
				details.source = 'appfolio_reports';
				details.appfolio_hit = true;
				description = wo.job_description || wo.service_request_description || null;
				if (wo.unit_id != null) {
					const resolved = await fetchUnitByAppfolioId({
						property_id: issue.property_id,
						appfolio_unit_id: String(wo.unit_id)
					});
					if (resolved) {
						unitId = resolved.id;
						unit = resolved;
					}
				}
			}
		} catch (err) {
			details.source = 'appfolio_reports_failed';
			details.error = err.message;
		}
	}

	if (!description) {
		description = parseAppfolioEmailBody(issue.description);
		if (description) details.source = 'appfolio_email_parse';
	}
	if (unitId && !unit) unit = await fetchUnit(unitId);

	return {
		unitId,
		unit,
		description: description || issue.description || null,
		details
	};
}

function buildMemoryQuestion(issue) {
	const property = issue.property?.name;
	const title = issue.name || 'work order';
	const desc = issue.description || '';
	return [
		'who should handle this maintenance work order',
		property ? `at ${property}` : null,
		`for ${title}`,
		desc ? `(${desc.slice(0, 160)})` : null
	]
		.filter(Boolean)
		.join(' ');
}

const TRADE_HINTS = [
	{
		trade: 'plumbing',
		terms: [
			'plumb',
			'leak',
			'drain',
			'faucet',
			'toilet',
			'sink',
			'water heater',
			'pipe',
			'shower',
			'garbage disposal'
		]
	},
	{
		trade: 'electrical',
		terms: ['electric', 'outlet', 'wiring', 'breaker', 'fuse', 'gfci', 'sparking']
	},
	{
		trade: 'hvac',
		terms: ['hvac', ' ac ', 'a/c', 'air conditioning', 'heat', 'heater', 'furnace', 'thermostat']
	},
	{
		trade: 'appliance',
		terms: ['appliance', 'dryer', 'washer', 'fridge', 'refrigerator', 'oven', 'stove', 'dishwasher']
	},
	{
		trade: 'pest',
		terms: [
			'pest',
			'roach',
			'cockroach',
			'rat',
			'mouse',
			'mice',
			'wasp',
			'bee',
			'spider',
			'termite'
		]
	},
	{
		trade: 'handyman',
		terms: ['door', 'window', 'lock', 'blind', 'cabinet', 'drywall', 'paint', 'handyman']
	}
];

function inferTrades(issue) {
	const text = ` ${[issue.name, issue.description].filter(Boolean).join(' ')} `.toLowerCase();
	const trades = [];
	for (const { trade, terms } of TRADE_HINTS) {
		if (terms.some((t) => text.includes(t))) trades.push(trade);
	}
	return trades;
}

function issueText(issue) {
	return [issue.name, issue.description].filter(Boolean).join(' - ');
}

function buildMemoryQueries(issue) {
	const property = issue.property?.name ?? null;
	const unit = issue.unit?.name ?? null;
	const text = issueText(issue);
	const trades = inferTrades(issue);
	const queries = [
		{
			question: buildMemoryQuestion(issue),
			property,
			issue: text
		}
	];

	if (trades.length) {
		queries.push({
			question: [
				`default ${trades.join('/')} vendor preferences`,
				property ? `for ${property}` : null,
				unit && unit !== property ? `or ${unit}` : null
			]
				.filter(Boolean)
				.join(' '),
			property,
			issue: trades.join(' ')
		});
	}

	if (unit && unit !== property) {
		queries.push({
			question: `unit or property-specific routing rules for ${unit}${property ? ` at ${property}` : ''}`,
			property,
			issue: text
		});
	}

	return queries.slice(0, 3);
}

function memoryCandidateKey(candidate) {
	const id = candidate?.data?.id;
	if (id) return `${candidate.kind}:${id}`;
	const name = candidate?.data?.name;
	if (name) return `${candidate.kind}:name:${String(name).toLowerCase()}`;
	return `${candidate.kind}:${candidate.provenance}`;
}

function combineMemoryResults(results, queries) {
	const byKey = new Map();
	const resolved = new Map();
	const tiers = new Set();

	for (const result of results) {
		for (const candidate of result?.candidates ?? []) {
			const key = memoryCandidateKey(candidate);
			const prev = byKey.get(key);
			if (!prev || (candidate.score ?? 0) > (prev.score ?? 0)) byKey.set(key, candidate);
		}
		for (const entity of result?.resolved_entities ?? []) {
			resolved.set(`${entity.kind}:${entity.id ?? entity.name}`, entity);
		}
		for (const tier of result?.tiers_fired ?? []) tiers.add(tier);
	}

	return {
		queries,
		candidates: [...byKey.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
		resolved_entities: [...resolved.values()],
		tiers_fired: [...tiers],
		note: 'Combined deterministic memory retrieval for the proactive new-work-order intake.'
	};
}

async function recallMemory(issue) {
	const queries = buildMemoryQueries(issue);
	const results = await Promise.all(
		queries.map((query) => readMemory.run(query, { workspace_id: issue.workspace_id }))
	);
	return combineMemoryResults(results, queries);
}

function compactMemory(memory) {
	return (memory?.candidates ?? []).slice(0, 18).map((c) => ({
		kind: c.kind,
		via: c.via,
		score: c.score,
		data: c.data,
		provenance: c.provenance
	}));
}

function locationFor(issue) {
	return issue.unit?.name || issue.property?.name || 'Unknown location';
}

function normalizeIssueContext(row, enriched) {
	return {
		id: row.id,
		workspace_id: row.workspace_id,
		appfolio_srn: row.appfolio_srn,
		created_at: row.created_at,
		property_id: row.property_id,
		unit_id: enriched.unitId ?? row.unit_id ?? null,
		tenant_id: row.tenant_id ?? null,
		vendor_id: row.vendor_id ?? null,
		name: row.name ?? null,
		description: enriched.description ?? row.description ?? null,
		urgent: Boolean(row.urgent),
		property: row.property ? { id: row.property.id, name: row.property.name } : null,
		unit: enriched.unit ? { id: enriched.unit.id, name: enriched.unit.name } : null,
		tenant: row.tenant ? { id: row.tenant.id, name: row.tenant.name } : null,
		vendor: row.vendor ? { id: row.vendor.id, name: row.vendor.name } : null
	};
}

function schema() {
	return {
		type: 'object',
		additionalProperties: false,
		required: [
			'title',
			'urgent',
			'urgency_reason',
			'issue_sentence',
			'vendor_id',
			'vendor_display'
		],
		properties: {
			title: { type: 'string' },
			urgent: { type: 'boolean' },
			urgency_reason: { type: 'string' },
			issue_sentence: { type: 'string' },
			vendor_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			vendor_display: { anyOf: [{ type: 'string' }, { type: 'null' }] }
		}
	};
}

async function decideMessage({ issue, vendors, memory }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: MODEL,
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: 'new_work_order_message',
					strict: true,
					schema: schema()
				}
			},
			messages: [
				{
					role: 'system',
					content: [
						'You write the proactive PM review draft for a new property maintenance work order.',
						'Return only the requested JSON.',
						'Pick a vendor only when the roster and memory support a real fit. Use null for vendor_id and vendor_display when no suitable vendor is clear.',
						'vendor_id must be exactly one id from the roster or null.',
						'vendor_display is how to ask the PM, usually the shortened roster display name.',
						'issue_sentence is one natural sentence under 15 words, ending with a period. No colons, semicolons, markdown, greetings, urgency prefix, owner approval, or signoff.',
						'urgent is true only for safety, health, or property-damage risk that cannot wait hours.'
					].join('\n')
				},
				{
					role: 'user',
					content: JSON.stringify(
						{
							issue: {
								id: issue.id,
								location: locationFor(issue),
								property: issue.property?.name ?? null,
								unit: issue.unit?.name ?? null,
								tenant: issue.tenant?.name ?? null,
								pms_title: issue.name ?? null,
								description: issue.description ?? null,
								pms_urgent: issue.urgent
							},
							vendors: vendors.map((v) => ({
								id: v.id,
								name: v.name,
								display: shortenVendorName(v.name, vendors)
							})),
							memory: compactMemory(memory)
						},
						null,
						2
					)
				}
			]
		})
	});
	if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 500)}`);
	const json = await res.json();
	const content = json.choices?.[0]?.message?.content;
	if (!content) throw new Error('OpenAI returned empty content');
	return JSON.parse(content);
}

function validateDecision(raw, vendors) {
	if (!raw || typeof raw !== 'object') throw new Error('decision is not an object');
	const title = String(raw.title ?? '').trim();
	const urgency_reason = String(raw.urgency_reason ?? '').trim();
	const issue_sentence = String(raw.issue_sentence ?? '').trim();
	if (!title) throw new Error('decision.title required');
	if (typeof raw.urgent !== 'boolean') throw new Error('decision.urgent must be boolean');
	if (!urgency_reason) throw new Error('decision.urgency_reason required');
	if (!issue_sentence) throw new Error('decision.issue_sentence required');
	if (!/\.$/.test(issue_sentence)) throw new Error('decision.issue_sentence must end with period');
	if (/[\n\r]/.test(issue_sentence)) throw new Error('decision.issue_sentence must be one line');
	if (/[;:]/.test(issue_sentence))
		throw new Error('decision.issue_sentence has forbidden punctuation');
	if (/\{[a-z_]+\}/i.test(issue_sentence))
		throw new Error('decision.issue_sentence has placeholder');
	if (/^(urgent|URGENT)\b/.test(issue_sentence))
		throw new Error('decision.issue_sentence has urgency prefix');

	const byId = new Map(vendors.map((v) => [v.id, v]));
	let vendor_id = raw.vendor_id == null ? null : String(raw.vendor_id).trim();
	let vendor_display = raw.vendor_display == null ? null : String(raw.vendor_display).trim();
	if (vendor_id) {
		if (!byId.has(vendor_id)) throw new Error(`decision.vendor_id not in roster: ${vendor_id}`);
		if (!vendor_display) throw new Error('decision.vendor_display required when vendor_id is set');
	} else {
		vendor_id = null;
		vendor_display = null;
	}

	return {
		title: title.slice(0, 120),
		urgent: raw.urgent,
		urgency_reason: urgency_reason.slice(0, 300),
		issue_sentence,
		vendor_id,
		vendor_display
	};
}

function buildDraftMessage(issue, decision) {
	const lines = [locationFor(issue), decision.issue_sentence];
	if (decision.vendor_id) {
		lines.push('', `Should I send ${decision.vendor_display}?`);
	}
	return lines.join('\n');
}

function toolCall(name, args, result, ok = true) {
	return { name, args, result, ok, error: ok ? null : (result?.error ?? null) };
}

function buildTrigger({ issue, vendors, userContent }) {
	return {
		event: 'new_issue',
		history: [],
		user_content: userContent,
		payload: { issue, candidate_vendors: vendors }
	};
}

function triggerContent(issue, vendors) {
	const vendorLines = vendors
		.map((v) => `  - ${shortenVendorName(v.name, vendors)} (id: ${v.id})`)
		.join('\n');
	return [
		'<system-reminder>',
		'<event>new_issue</event>',
		'</system-reminder>',
		'',
		'<system-reminder>',
		'# issue context',
		`New work order:`,
		`issue_id: ${issue.id}`,
		`Property: ${issue.property?.name ?? '(unknown)'}`,
		`Unit: ${issue.unit?.name ?? '(none)'}`,
		`Title: ${issue.name ?? '(untitled)'}`,
		`Description: ${issue.description ?? '(none)'}`,
		`Tenant: ${issue.tenant?.name ?? '(unknown)'}`,
		`Urgent: ${issue.urgent ? 'yes' : 'no'}`,
		'',
		'Candidate vendors:',
		vendorLines || '  (none)',
		'</system-reminder>'
	].join('\n');
}

async function writeFailureTurn({
	issue,
	workspace,
	chatGuid,
	failure,
	steps = [],
	startTime,
	trigger
}) {
	await appendTurnLog({
		ts: nowIso(),
		event: 'new_issue',
		skill: 'new_work_order_message',
		model: MODEL,
		turn_id: newTurnId(),
		workspace_id: issue?.workspace_id ?? null,
		workspace_label: workspace?.label ?? null,
		handle: null,
		chat_guid: chatGuid ?? null,
		session_id: null,
		issue_id: issue?.id ?? null,
		kind: 'failure',
		iterations: 1,
		tool_calls: steps
			.flatMap((s) => s.tool_calls ?? [])
			.map((c) => ({
				name: c.name,
				ok: c.ok !== false,
				error: c.error ?? null
			})),
		trigger: trigger ?? {
			event: 'new_issue',
			history: [],
			user_content: null,
			payload: issue ? { issue, candidate_vendors: [] } : null
		},
		steps,
		outbox_count: 0,
		drafts_count: 0,
		failure,
		duration_ms: Date.now() - startTime
	});
}

async function writeCompletedTurn({
	issue,
	workspace,
	chatGuid,
	trigger,
	steps,
	draft,
	startTime
}) {
	await appendTurnLog({
		ts: nowIso(),
		event: 'new_issue',
		skill: 'new_work_order_message',
		model: MODEL,
		turn_id: newTurnId(),
		workspace_id: issue.workspace_id,
		workspace_label: workspace.label,
		handle: null,
		chat_guid: chatGuid,
		session_id: null,
		issue_id: issue.id,
		kind: 'completed',
		iterations: 1,
		tool_calls: steps
			.flatMap((s) => s.tool_calls ?? [])
			.map((c) => ({
				name: c.name,
				ok: c.ok !== false,
				error: c.error ?? null
			})),
		trigger,
		steps,
		outbox_count: 0,
		drafts_count: 1,
		failure: null,
		draft_id: draft.id,
		duration_ms: Date.now() - startTime
	});
}

export async function processNewWorkOrder({
	issue_id,
	workspace_id = null,
	workspace,
	chatGuid,
	participants = []
}) {
	const startTime = Date.now();
	const steps = [];
	let issue = null;
	let trigger = null;

	try {
		const row = await fetchIssueRow(issue_id);
		if (!row) throw new Error(`issue not found: ${issue_id}`);
		const ws = workspace ?? WORKSPACES[row.workspace_id];
		if (!ws) throw new Error(`unknown workspace: ${row.workspace_id}`);

		const enriched = await enrichFromAppfolio(row, ws);
		issue = normalizeIssueContext(row, enriched);
		const vendors = await fetchWorkspaceVendors(issue.workspace_id);
		trigger = buildTrigger({ issue, vendors, userContent: triggerContent(issue, vendors) });

		steps.push({
			i: 1,
			reasoning: null,
			tool_calls: [
				toolCall('appfolio_lookup', { issue_id }, enriched.details),
				toolCall(
					'workspace_vendors',
					{ workspace_id: issue.workspace_id },
					{ count: vendors.length }
				)
			]
		});

		const memory = await recallMemory(issue);
		const memoryQueries = memory.queries ?? [];
		steps.push({
			i: 2,
			reasoning: null,
			tool_calls: [toolCall('read_memory', { queries: memoryQueries }, memory)]
		});

		const rawDecision = await decideMessage({ issue, vendors, memory });
		const decision = validateDecision(rawDecision, vendors);
		issue = {
			...issue,
			name: decision.title,
			urgent: decision.urgent,
			urgency_reason: decision.urgency_reason,
			vendor_id: decision.vendor_id
		};
		const body = buildDraftMessage(issue, decision);
		const patch = {
			name: decision.title,
			description: issue.description,
			urgent: decision.urgent,
			unit_id: issue.unit_id,
			vendor_id: decision.vendor_id
		};
		for (const [k, v] of Object.entries(patch)) if (v === undefined) delete patch[k];
		const patched = await patchIssue(issue.id, patch);
		steps.push({
			i: 3,
			reasoning: null,
			tool_calls: [
				toolCall('new_work_order_message', { issue_id: issue.id }, decision),
				toolCall('update_issue', { issue_id: issue.id, ...patch }, { ok: true, issue_id: issue.id })
			]
		});

		const draft = await enqueuePmReviewDraft({
			trigger: 'new_issue',
			channel: 'groupchat',
			workspace_id: issue.workspace_id,
			workspace_label: ws.label,
			issue_id: issue.id,
			to: chatGuid,
			to_participants: participants,
			messages: [{ body }]
		});
		steps.push({
			i: 4,
			reasoning: null,
			tool_calls: [
				toolCall(
					'enqueue_draft',
					{ trigger: 'new_issue', channel: 'groupchat', issue_id: issue.id },
					{ ok: true, draft_id: draft.id, hold_until: draft.hold_until ?? null }
				)
			]
		});

		issue = {
			...issue,
			...(patched ?? {}),
			property: issue.property,
			unit: issue.unit,
			tenant: issue.tenant,
			urgency_reason: decision.urgency_reason
		};
		trigger = buildTrigger({ issue, vendors, userContent: triggerContent(issue, vendors) });
		await writeCompletedTurn({
			issue,
			workspace: ws,
			chatGuid,
			trigger,
			steps,
			draft,
			startTime
		});
		return { ok: true, draft, issue };
	} catch (err) {
		const failure = { stage: 'new_work_order_intake', error: err.message };
		await writeFailureTurn({
			issue: issue ?? { id: issue_id, workspace_id },
			workspace,
			chatGuid,
			failure,
			steps,
			startTime,
			trigger
		});
		return { ok: false, failure };
	}
}
