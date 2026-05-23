// @ts-nocheck
// V2 intake — PR7 gutted shim.
//
// Receives a parsed AppFolio work-order email from pubsub-hook, resolves
// property_id and tenant_id via cheap DB lookups, inserts ONE issues_v2 row,
// and returns. That's it.
//
// All downstream enrichment (AppFolio reports fetch for unit, LLM name +
// urgent extraction, vendor selection) now runs in the Node agent process
// via the enrich_issue + read_memory + set_vendor tools. The old intake-
// agent (LLM + AppFolio enrichment + vendor-agent dispatch) has been
// retired — see agent/skills/process_wo.mjs.
//
// Dedup is now structural: UNIQUE (workspace_id, appfolio_srn) on issues_v2.
// On conflict we ignore and return ok — the existing row is already being
// processed by the Node poller.
//
// Name kept as `intake-agent` so pubsub-hook (frozen webapp) doesn't need
// to change. The directory name is now misleading; treat this as the
// "ingest shim." Rename + URL update is a future PR.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false }
});

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

	console.log(
		`intake-shim: ${isTest ? 'TEST' : `WO #${payload.serviceRequestNumber} property=${payload.appfolioPropertyId}`} msg=${gmailMessageId}`
	);

	// Resolve everything we can from email + DB before the insert.
	let appfolioSrn: string;
	let propertyDbId: string | null = null;
	let tenantId: string | null = null;
	let initialDescription: string;

	if (isTest) {
		appfolioSrn = `test-${gmailMessageId}`;
		initialDescription = (emailBody && emailBody.trim()) || subject || 'Test work order';
	} else {
		const { serviceRequestNumber, appfolioPropertyId: propNumber } = payload;
		const baseSrn = String(serviceRequestNumber).split('-')[0]; // strip email-only "-N" suffix
		appfolioSrn = baseSrn;
		initialDescription = (emailBody && emailBody.trim()) || subject || '';

		// Property lookup. The agent's enrich_issue tool needs property_id to
		// find appfolio_property_id on the properties table for the reports API.
		const { data: property } = await supabase
			.from('properties')
			.select('id')
			.eq('workspace_id', workspaceId)
			.eq('appfolio_property_number', propNumber)
			.maybeSingle();
		propertyDbId = property?.id ?? null;
		if (!propertyDbId) {
			console.warn(`intake-shim: no property for number=${propNumber} — inserting without property_id`);
		}

		// Tenant: exact-match on parsed "Resident Name:" scoped to the property's
		// units. Unit isn't reliably resolvable from the email alone — that's
		// done by enrich_issue via the AppFolio reports API.
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

	// Insert the row. On conflict (workspace_id, appfolio_srn) ignore — the
	// existing row is already being handled by the Node poller.
	const { data: upserted, error: upsertErr } = await supabase
		.from('issues_v2')
		.upsert(
			{
				workspace_id: workspaceId,
				appfolio_srn: appfolioSrn,
				description: initialDescription,
				property_id: propertyDbId,
				tenant_id: tenantId
			},
			{ onConflict: 'workspace_id,appfolio_srn', ignoreDuplicates: true }
		)
		.select('id');

	if (upsertErr) {
		console.error('intake-shim: issue upsert error:', upsertErr.message);
		return Response.json({ ok: false, error: upsertErr.message }, { status: 500 });
	}

	let issueId = upserted?.[0]?.id ?? null;
	if (!issueId) {
		// Duplicate — fetch existing for the response.
		const { data: existing } = await supabase
			.from('issues_v2')
			.select('id')
			.eq('workspace_id', workspaceId)
			.eq('appfolio_srn', appfolioSrn)
			.maybeSingle();
		issueId = existing?.id ?? null;
		console.log(`intake-shim: duplicate SRN=${appfolioSrn} — existing issue=${issueId}`);
		return Response.json({ ok: true, issueId, skipped: 'duplicate' });
	}

	console.log(
		`intake-shim: inserted ${issueId} property=${propertyDbId ?? '—'} tenant=${tenantId ?? '—'} — Node poller will pick up`
	);
	return Response.json({ ok: true, issueId });
});
