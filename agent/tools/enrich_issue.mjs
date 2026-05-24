// enrich_issue — the first tool process_wo calls. Takes a freshly-inserted
// issues_v2 row (raw description + property_id/tenant_id resolved by the
// intake shim) and fills in the rest:
//
//   - AppFolio reports API: unit_id + a cleaner job_description
//   - Mini LLM: a 3–7 word title (`name`)
//   - PATCH issues_v2 with all of the above
//
// Returns the enriched fields so the agent can hint read_memory with a
// property name and draft a ping that names the unit. Ported from the old
// intake-agent edge function; deletes the AppFolio call + LLM out of the
// edge surface.

import { supabaseEnv } from '../core/supabase.mjs';

const APPFOLIO_MODEL = process.env.ENRICH_MODEL || 'gpt-5.4-mini-2026-03-17';

export const enrichIssue = {
	name: 'enrich_issue',
	description:
		'Fill in property/unit/tenant context and a short title for a freshly-arrived work order. Run this BEFORE read_memory and send_text — without it the work order may be missing the unit number and a clean description. Pass the issue_id from your task context. Returns the enriched fields and PATCHes the issues_v2 row.',
	parameters: {
		type: 'object',
		additionalProperties: false,
		required: ['issue_id'],
		properties: {
			issue_id: { type: 'string', description: 'UUID of the issues_v2 row to enrich.' }
		}
	},
	async run({ issue_id }, ctx) {
		// Eval mode: no AppFolio, no OpenAI, no Supabase writes. Return the
		// fixture the scenario already provided in ctx.issue so the agent can
		// keep working with realistic data. The suite asserts the call HAPPENED;
		// the data shape comes from the fixture.
		if (process.env.BEDROCK_EVAL_MODE === '1') {
			const f = ctx.issue ?? {};
			return {
				ok: true,
				property: f.property ?? null,
				unit: f.unit ?? null,
				tenant: f.tenant ?? null,
				name: f.name ?? null,
				description: f.description ?? null,
				eval_mode: true
			};
		}

		// 1. Load the row + property's appfolio_property_id.
		const row = await fetchIssueRow(issue_id);
		if (!row) return { ok: false, error: `enrich_issue: issue ${issue_id} not found` };
		const property = row.property_id ? await fetchProperty(row.property_id) : null;

		// 2. AppFolio reports API → unit + cleaner desc. Failure here is
		//    non-fatal; row keeps its email-derived description.
		let unitId = row.unit_id ?? null;
		let cleanDescription = null;
		if (property?.appfolio_property_id && row.appfolio_srn) {
			try {
				const wo = await fetchAppfolioWorkOrder({
					appfolio_property_id: property.appfolio_property_id,
					srn: row.appfolio_srn
				});
				if (wo) {
					cleanDescription = wo.job_description || wo.service_request_description || null;
					if (wo.unit_id != null) {
						const unit = await fetchUnitByAppfolioId({
							property_id: row.property_id,
							appfolio_unit_id: String(wo.unit_id)
						});
						unitId = unit?.id ?? unitId;
					}
				}
			} catch (err) {
				console.error(`enrich_issue: AppFolio fetch failed for ${issue_id}: ${err.message}`);
			}
		}

		// 3. LLM: extract a short title from the cleanest description we have.
		const descriptionForLlm = cleanDescription || row.description || '';
		let name = row.name ?? null;
		if (descriptionForLlm) {
			try {
				name = await extractName(descriptionForLlm);
			} catch (err) {
				console.error(`enrich_issue: LLM extract failed for ${issue_id}: ${err.message}`);
			}
		}

		// 4. PATCH the row with whatever we resolved.
		const update = {};
		if (unitId && unitId !== row.unit_id) update.unit_id = unitId;
		if (cleanDescription && cleanDescription !== row.description) update.description = cleanDescription;
		if (name && name !== row.name) update.name = name;
		if (Object.keys(update).length > 0) {
			await patchIssueRow(issue_id, update);
		}

		// 5. Fetch tenant + unit names for the return shape (so the agent has a
		//    ready-to-quote display name without a second tool call).
		const [tenant, unit] = await Promise.all([
			row.tenant_id ? fetchTenant(row.tenant_id) : Promise.resolve(null),
			unitId ? fetchUnit(unitId) : Promise.resolve(null)
		]);

		return {
			ok: true,
			property: property ? { id: property.id, name: property.name } : null,
			unit: unit ? { id: unit.id, name: unit.name } : null,
			tenant: tenant ? { id: tenant.id, name: tenant.name } : null,
			name,
			description: cleanDescription || row.description || null
		};
	}
};

// ─── Supabase helpers ──────────────────────────────────────────────────────

function supabaseHeaders() {
	const { key } = supabaseEnv();
	return {
		apikey: key,
		Authorization: `Bearer ${key}`,
		'Content-Type': 'application/json',
		Accept: 'application/json'
	};
}

async function fetchIssueRow(issue_id) {
	const { url } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,workspace_id,appfolio_srn,description,property_id,tenant_id,unit_id,name',
		id: `eq.${issue_id}`,
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/issues_v2?${params}`, { headers: supabaseHeaders() });
	if (!res.ok) throw new Error(`fetchIssueRow ${res.status}: ${await res.text()}`);
	const rows = await res.json();
	return rows[0] ?? null;
}

async function fetchProperty(property_id) {
	const { url } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,name,appfolio_property_id',
		id: `eq.${property_id}`,
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/properties?${params}`, { headers: supabaseHeaders() });
	if (!res.ok) throw new Error(`fetchProperty ${res.status}: ${await res.text()}`);
	const rows = await res.json();
	return rows[0] ?? null;
}

async function fetchUnit(unit_id) {
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

async function fetchTenant(tenant_id) {
	const { url } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,name',
		id: `eq.${tenant_id}`,
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/tenants?${params}`, { headers: supabaseHeaders() });
	if (!res.ok) throw new Error(`fetchTenant ${res.status}: ${await res.text()}`);
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

async function patchIssueRow(issue_id, fields) {
	const { url } = supabaseEnv();
	const res = await fetch(
		`${url}/rest/v1/issues_v2?id=eq.${encodeURIComponent(issue_id)}`,
		{ method: 'PATCH', headers: supabaseHeaders(), body: JSON.stringify(fields) }
	);
	if (!res.ok) throw new Error(`patchIssueRow ${res.status}: ${await res.text()}`);
}

// ─── AppFolio reports API ──────────────────────────────────────────────────

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

// Fetch the single work-order row matching {srn} within a tight property+date
// window. Double-bounded by property AND date so a wrong property_id surfaces
// as an empty result instead of silently dumping all active WOs.
async function fetchAppfolioWorkOrder({ appfolio_property_id, srn }) {
	const { id, secret, vhost } = appfolioCreds();
	const baseSrn = String(srn).split('-')[0]; // strip email-only "-N" suffix
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

	const url = `https://${id}:${secret}@${vhost}/api/v2/reports/work_order.json`;
	const rows = [];
	let nextUrl = url;
	let isFirst = true;
	while (nextUrl) {
		let res = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			res = await fetch(nextUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: isFirst ? JSON.stringify(body) : JSON.stringify({})
			});
			if (res.status !== 429) break;
			const retryAfter = Math.min(Number(res.headers.get('retry-after') ?? attempt * 5), 15);
			await new Promise((r) => setTimeout(r, retryAfter * 1000 + Math.floor(Math.random() * 2000)));
		}
		if (!res || !res.ok) {
			const text = (await res?.text()) ?? '';
			throw new Error(`AppFolio work_order ${res?.status}: ${text}`);
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

// ─── Mini LLM ──────────────────────────────────────────────────────────────

async function extractName(description) {
	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
		},
		body: JSON.stringify({
			model: APPFOLIO_MODEL,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content:
						'You are a maintenance ticket triager. Given a work order description, return JSON with one field:\n' +
						'- name: a 3-7 word title summarizing the issue (e.g. "Leaking kitchen faucet", "Broken bedroom window"). No quotes, no period.'
				},
				{ role: 'user', content: description }
			]
		})
	});
	if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const json = await res.json();
	const content = json.choices?.[0]?.message?.content ?? '{}';
	const parsed = JSON.parse(content);
	return String(parsed.name ?? '').slice(0, 120) || 'Work order';
}
