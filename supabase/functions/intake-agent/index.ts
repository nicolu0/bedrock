// @ts-nocheck
// V2 intake. Receives parsed AppFolio work-order email from pubsub-hook.
// Atomically dedupes by Gmail message_id, inserts an issues_v2 row immediately
// from email-derived data so failures downstream don't lose the WO, asks an
// LLM for name + urgent, fires vendor-agent, then enriches from AppFolio last.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { ensureAgentRuns, claimAgentRun, completeAgentRun, failAgentRun } from '../_shared/agent-runs.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APPFOLIO_CLIENT_ID = Deno.env.get('APPFOLIO_CLIENT_ID')!;
const APPFOLIO_CLIENT_SECRET = Deno.env.get('APPFOLIO_CLIENT_SECRET')!;
const APPFOLIO_VHOST = Deno.env.get('APPFOLIO_VHOST')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!;
const OPENAI_MODEL = 'gpt-4.1-mini';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false }
});

// ── AppFolio API ─────────────────────────────────────────────────────────────

function appfolioUrl(reportName: string): string {
	return `https://${APPFOLIO_CLIENT_ID}:${APPFOLIO_CLIENT_SECRET}@${APPFOLIO_VHOST}/api/v2/reports/${reportName}.json`;
}

async function appfolioFetch(reportName: string, body: Record<string, unknown>): Promise<unknown[]> {
	const rows: unknown[] = [];
	let url: string | null = appfolioUrl(reportName);
	let isFirst = true;
	while (url) {
		let res: Response | null = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			res = await fetch(url, {
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
			throw new Error(`AppFolio ${reportName} ${res?.status}: ${text}`);
		}
		const json = await res.json();
		if (Array.isArray(json)) { rows.push(...json); break; }
		rows.push(...(json.results ?? []));
		url = json.next_page_url ?? null;
		isFirst = false;
	}
	return rows;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeTenantName(name: string | null | undefined): string | null {
	if (!name) return null;
	const trimmed = name.trim();
	if (trimmed.includes(',')) {
		const [last, ...rest] = trimmed.split(',');
		const first = rest.join(',').trim();
		return first ? `${first} ${last.trim()}` : last.trim();
	}
	return trimmed;
}

function parseAppfolioBody(body: string) {
	const m = body.match(/Resident Name:\s*(.+)/);
	return { residentName: m?.[1]?.trim() ?? null };
}

function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

async function generateNameAndUrgency(description: string): Promise<{ name: string; urgent: boolean }> {
	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${OPENAI_API_KEY}`
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content:
						'You are a maintenance ticket triager. Given a work order description, return JSON with two fields:\n' +
						'- name: a 3-7 word title summarizing the issue (e.g. "Leaking kitchen faucet", "Broken bedroom window"). No quotes, no period.\n' +
						'- urgent: boolean. True only if the issue poses safety, health, or rapid property damage risk (active leak, no heat in winter, no AC in heat, no hot water, gas smell, electrical sparking, lockout, sewage backup). False for routine repairs.'
				},
				{ role: 'user', content: description }
			]
		})
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
	}
	const json = await res.json();
	const content = json.choices?.[0]?.message?.content ?? '{}';
	const parsed = JSON.parse(content);
	return {
		name: String(parsed.name ?? '').slice(0, 120) || 'Work order',
		urgent: Boolean(parsed.urgent)
	};
}

async function dispatchVendorAgent(issueId: string): Promise<void> {
	// Awaited because fire-and-forget HTTP from edge functions gets aborted on
	// shutdown. Adds vendor-agent latency to intake's response.
	try {
		const res = await fetch(`${SUPABASE_URL}/functions/v1/vendor-agent`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				apikey: SUPABASE_SERVICE_ROLE_KEY,
				Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
			},
			body: JSON.stringify({ issueId })
		});
		if (!res.ok) console.error(`vendor-agent dispatch ${res.status}: ${(await res.text()).slice(0, 200)}`);
	} catch (err) {
		console.error('vendor-agent dispatch failed:', err);
	}
}

// AppFolio enrichment: fetched last, non-blocking. On failure, the row keeps
// its email-derived data and the user-visible flow is unaffected.
async function enrichFromAppfolio(
	issueId: string,
	baseSrn: string,
	appfolioPropertyId: string,
	propertyDbId: string
): Promise<void> {
	try {
		const today = new Date();
		const fromDate = new Date(today);
		fromDate.setDate(fromDate.getDate() - 3);
		const toDate = new Date(today);
		toDate.setDate(toDate.getDate() + 1);

		// Double-bounded: property AND date. If property_id ever drifts, the
		// empty result is loud (vs. silently dumping all 100+ active WOs).
		const rows = await appfolioFetch('work_order', {
			property_visibility: 'active',
			property: { property_id: appfolioPropertyId },
			work_order_statuses: ['0', '1', '2', '9', '3', '6', '8', '12', '4', '5', '7'],
			status_date: '0',
			status_date_range_from: isoDate(fromDate),
			status_date_range_to: isoDate(toDate),
			columns: [
				'work_order_id', 'service_request_number', 'property_id', 'unit_id',
				'job_description', 'service_request_description'
			]
		});

		const row = (rows as any[]).find((r) => String(r.service_request_number) === baseSrn);
		if (!row) {
			console.warn(`enrich: no AppFolio match for SRN=${baseSrn} property_id=${appfolioPropertyId}`);
			return;
		}

		// Resolve our unit_id from AppFolio's unit_id, scoped to this property.
		let unitId: string | null = null;
		if (row.unit_id != null) {
			const { data: unit } = await supabase
				.from('units')
				.select('id')
				.eq('property_id', propertyDbId)
				.eq('appfolio_unit_id', String(row.unit_id))
				.maybeSingle();
			unitId = unit?.id ?? null;
		}

		const cleanDescription = row.job_description || row.service_request_description || null;
		const update: Record<string, unknown> = {};
		if (unitId) update.unit_id = unitId;
		if (cleanDescription) update.description = cleanDescription;

		if (Object.keys(update).length > 0) {
			const { error } = await supabase.from('issues_v2').update(update).eq('id', issueId);
			if (error) console.error(`enrich: update issue ${issueId}: ${error.message}`);
			else console.log(`enrich: ${issueId} updated unit_id=${unitId ?? '—'} desc_overwritten=${!!cleanDescription}`);
		}
	} catch (err) {
		console.error(`enrich: failed for issue ${issueId}:`, err instanceof Error ? err.message : err);
	}
}

// ── Main Handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
	const payload = await req.json();
	const { workspaceId, gmailMessageId, body: emailBody, subject, isTest } = payload;

	if (!workspaceId || !gmailMessageId) {
		return Response.json({ ok: false, error: 'Missing required fields' }, { status: 400 });
	}
	if (!isTest && (!payload.serviceRequestNumber || !payload.appfolioPropertyId)) {
		return Response.json({ ok: false, error: 'Missing AppFolio fields' }, { status: 400 });
	}

	console.log(`intake-agent: ${isTest ? 'TEST' : `WO #${payload.serviceRequestNumber} property=${payload.appfolioPropertyId}`} msg=${gmailMessageId}`);

	// Atomic dedup: insert message_id; on conflict (already processed), bail.
	const { data: dedupRow, error: dedupErr } = await supabase
		.from('gmail_message_dedup')
		.insert({ message_id: gmailMessageId })
		.select('message_id')
		.maybeSingle();

	if (dedupErr) {
		if (dedupErr.code === '23505') {
			console.log(`intake-agent: duplicate message ${gmailMessageId}, skipping`);
			return Response.json({ ok: true, skipped: true, reason: 'duplicate' });
		}
		console.error('intake-agent: dedup insert error:', dedupErr.message);
		return Response.json({ ok: false, error: dedupErr.message }, { status: 500 });
	}
	if (!dedupRow) {
		return Response.json({ ok: true, skipped: true, reason: 'duplicate-no-row' });
	}

	// Resolve everything we can from email + DB before any external calls.
	let appfolioId: string;          // upsert key on issues_v2
	let baseSrn: string | null = null;
	let propertyDbId: string | null = null;
	let appfolioPropertyId: string | null = null;
	let tenantId: string | null = null;
	let initialDescription: string;

	if (isTest) {
		appfolioId = `test-${gmailMessageId}`;
		initialDescription = (emailBody && emailBody.trim()) || subject || 'Test work order';
	} else {
		const { serviceRequestNumber, appfolioPropertyId: propNumber } = payload;
		baseSrn = String(serviceRequestNumber).split('-')[0];   // strip email-only "-N" suffix
		appfolioId = baseSrn;
		initialDescription = (emailBody && emailBody.trim()) || subject || '';

		const { data: property } = await supabase
			.from('properties')
			.select('id, appfolio_property_id')
			.eq('workspace_id', workspaceId)
			.eq('appfolio_property_number', propNumber)
			.maybeSingle();

		if (property) {
			propertyDbId = property.id;
			appfolioPropertyId = property.appfolio_property_id ?? null;
		} else {
			console.warn(`intake-agent: no property for number=${propNumber} — proceeding without property_id`);
		}

		// Tenant: exact-match on parsed "Resident Name:" scoped to property's units.
		// Unit isn't reliably resolvable from email alone — left for enrichment.
		const tenantName = normalizeTenantName(parseAppfolioBody(emailBody ?? '').residentName);
		if (propertyDbId && tenantName) {
			const { data: unitRows } = await supabase
				.from('units')
				.select('id')
				.eq('property_id', propertyDbId);
			const unitIds = (unitRows ?? []).map((u: any) => u.id);
			if (unitIds.length > 0) {
				const { data: tenantMatch } = await supabase
					.from('tenants')
					.select('id')
					.in('unit_id', unitIds)
					.eq('name', tenantName)
					.limit(1)
					.maybeSingle();
				tenantId = tenantMatch?.id ?? null;
			}
		}
	}

	// Insert issue immediately. If a duplicate (workspace_id, appfolio_id) row
	// already exists, ignore — agent_runs claim will short-circuit downstream.
	const { data: upserted, error: upsertErr } = await supabase
		.from('issues_v2')
		.upsert(
			{
				workspace_id: workspaceId,
				appfolio_id: appfolioId,
				description: initialDescription,
				property_id: propertyDbId,
				tenant_id: tenantId
			},
			{ onConflict: 'workspace_id,appfolio_id', ignoreDuplicates: true }
		)
		.select('id');

	if (upsertErr) {
		console.error('intake-agent: issue upsert error:', upsertErr.message);
		return Response.json({ ok: false, error: upsertErr.message }, { status: 500 });
	}

	let issueId = upserted?.[0]?.id ?? null;
	if (!issueId) {
		const { data: existing } = await supabase
			.from('issues_v2')
			.select('id')
			.eq('workspace_id', workspaceId)
			.eq('appfolio_id', appfolioId)
			.maybeSingle();
		issueId = existing?.id ?? null;
	}

	if (!issueId) {
		console.error('intake-agent: could not resolve issue id');
		return Response.json({ ok: false, error: 'Issue id resolution failed' }, { status: 500 });
	}

	// Create both agent_runs rows up front so the status page can see the
	// pipeline progressing. Claim intake immediately.
	await ensureAgentRuns(supabase, issueId, ['intake', 'vendor']);
	await supabase.from('gmail_message_dedup').update({ issue_id: issueId }).eq('message_id', gmailMessageId);

	const intakeRunId = await claimAgentRun(supabase, issueId, 'intake');
	if (!intakeRunId) {
		console.log(`intake-agent: ${issueId} intake already claimed/done — firing vendor and exiting`);
		await dispatchVendorAgent(issueId);
		return Response.json({ ok: true, issueId, skipped: 'intake-already-claimed' });
	}

	try {
		if (!initialDescription) throw new Error('work order has no description');
		const { name, urgent } = await generateNameAndUrgency(initialDescription);

		const { error: updateErr } = await supabase
			.from('issues_v2')
			.update({ name, urgent })
			.eq('id', issueId);
		if (updateErr) throw new Error(`update issue: ${updateErr.message}`);

		await completeAgentRun(supabase, issueId, 'intake');
		console.log(`intake-agent: ${issueId} intake done — name="${name}" urgent=${urgent}`);

		// Vendor fires on email-derived data — doesn't wait on AppFolio.
		await dispatchVendorAgent(issueId);

		// AppFolio enrichment is the last step. Awaited so the response reflects
		// final row state, but failures here don't break anything.
		if (!isTest && baseSrn && appfolioPropertyId && propertyDbId) {
			await enrichFromAppfolio(issueId, baseSrn, appfolioPropertyId, propertyDbId);
		}

		return Response.json({ ok: true, issueId, name, urgent });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`intake-agent: ${issueId} intake failed:`, message);
		await failAgentRun(supabase, issueId, 'intake', err);
		return Response.json({ ok: false, error: message }, { status: 500 });
	}
});
