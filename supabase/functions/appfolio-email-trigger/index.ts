// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_JWT = Deno.env.get('ANON_JWT')!;
const INTERNAL_AGENT_KEY = Deno.env.get('INTERNAL_AGENT_KEY')!;
const APPFOLIO_CLIENT_ID = Deno.env.get('APPFOLIO_CLIENT_ID')!;
const APPFOLIO_CLIENT_SECRET = Deno.env.get('APPFOLIO_CLIENT_SECRET')!;
const APPFOLIO_VHOST = Deno.env.get('APPFOLIO_VHOST')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false }
});

// ── AppFolio API ─────────────────────────────────────────────────────────────

function appfolioUrl(reportName: string): string {
	return `https://${APPFOLIO_CLIENT_ID}:${APPFOLIO_CLIENT_SECRET}@${APPFOLIO_VHOST}/api/v2/reports/${reportName}.json`;
}

async function appfolioFetch(
	urlOrReport: string,
	body: Record<string, unknown> = {},
	isPageUrl = false
): Promise<unknown[]> {
	const rows: unknown[] = [];
	let url: string | null = isPageUrl ? urlOrReport : appfolioUrl(urlOrReport);
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
			const retryAfter = Math.min(Number(res.headers.get('retry-after') ?? (attempt * 5)), 15);
			const jitter = Math.floor(Math.random() * 2000);
			console.warn(`AppFolio ${urlOrReport} rate limited, retrying in ${retryAfter}s (attempt ${attempt}/3)`);
			await new Promise(r => setTimeout(r, retryAfter * 1000 + jitter));
		}
		if (!res || !res.ok) {
			const text = await res?.text() ?? '';
			throw new Error(`AppFolio ${urlOrReport} ${res?.status}: ${text}`);
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

function mapWorkOrderStatus(status: string): string {
	const s = (status ?? '').toLowerCase().trim();
	if (s === 'completed' || s === 'canceled' || s === 'completed no need to bill') return 'done';
	if (s === 'assigned' || s === 'scheduled' || s === 'waiting' || s === 'work done' || s === 'ready to bill') return 'in_progress';
	return 'todo';
}

function normalizePhone(raw: string | null): string | null {
	if (!raw) return null;
	let digits = raw.replace(/\D/g, '');
	if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
	return digits.length === 10 ? digits : null;
}

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

// ── Email Parsing ────────────────────────────────────────────────────────────

// Subject: "WO #7561-1 - Water Heater - 292 - 292-8"
function parseAppfolioSubject(subject: string) {
	const parts = subject.split(' - ');
	const woMatch = (parts[0] ?? '').match(/WO\s*#([\w-]+)/i);
	return {
		serviceRequestNumber: woMatch?.[1] ?? null,
		descriptor: parts[1]?.trim() ?? null,
		propertyId: parts.length >= 3 ? parts[parts.length - 2].trim() : null,
		unitId: parts.length >= 4 ? parts[parts.length - 1].trim() : null,
	};
}

// Body parsing — extract structured fields from the notification email
function parseAppfolioBody(body: string) {
	const field = (pattern: RegExp): string | null => {
		const m = body.match(pattern);
		return m?.[1]?.trim() ?? null;
	};
	return {
		jobDescription: field(/Job Description\s*[:\n]\s*(.+?)(?:\n\n|\nIssue)/s),
		residentName: field(/Resident Name:\s*(.+)/),
		residentPhone: field(/Resident Phone Number:\s*(.+)/),
		residentEmail: field(/Resident Email:\s*(.+)/),
		address: field(/Address:\s*(.+)/),
	};
}

// ── Agent Dispatch ───────────────────────────────────────────────────────────

async function dispatchToAgent(event: {
	source: string;
	issueId: string;
	workspaceId: string;
	change_type: string;
	row: any;
	run_id?: string;
}): Promise<void> {
	const res = await fetch(`${SUPABASE_URL}/functions/v1/agent`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: ANON_JWT,
			Authorization: `Bearer ${ANON_JWT}`,
			'x-internal-agent-key': INTERNAL_AGENT_KEY
		},
		body: JSON.stringify(event)
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`agent HTTP ${res.status}: ${text.slice(0, 200)}`);
	}
}

// ── Main Handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
	// Validate internal call
	const agentKey = req.headers.get('x-internal-agent-key');
	if (agentKey !== INTERNAL_AGENT_KEY) {
		return new Response('Unauthorized', { status: 401 });
	}

	const body = await req.json();
	const { workspaceId, serviceRequestNumber, appfolioPropertyId, subject, body: emailBody, gmailMessageId } = body;

	if (!workspaceId || !serviceRequestNumber || !appfolioPropertyId) {
		return Response.json({ ok: false, error: 'Missing required fields' }, { status: 400 });
	}

	console.log(`appfolio-email-trigger: WO #${serviceRequestNumber} property=${appfolioPropertyId} workspace=${workspaceId}`);

	// Dedup: check if we already processed this Gmail message
	if (gmailMessageId) {
		const { data: existing } = await supabase
			.from('activity_logs')
			.select('id')
			.eq('type', 'issue_created')
			.contains('data', { gmail_message_id: gmailMessageId })
			.maybeSingle();
		if (existing) {
			console.log(`appfolio-email-trigger: already processed gmail message ${gmailMessageId}`);
			return Response.json({ ok: true, skipped: true, reason: 'duplicate' });
		}
	}

	// The email subject contains the property NUMBER (e.g., "292"), not the internal
	// appfolio_property_id (e.g., "202"). Look up by appfolio_property_number.
	const { data: property } = await supabase
		.from('properties')
		.select('id, appfolio_property_id, appfolio_property_number')
		.eq('workspace_id', workspaceId)
		.eq('appfolio_property_number', appfolioPropertyId)
		.maybeSingle();

	if (!property) {
		console.error(`appfolio-email-trigger: no Bedrock property for property_number=${appfolioPropertyId}`);
		return Response.json({ ok: false, error: `Unknown property number ${appfolioPropertyId}` }, { status: 404 });
	}

	// Look up unit mappings
	const { data: unitRows } = await supabase
		.from('units')
		.select('id, property_id, appfolio_unit_id')
		.eq('property_id', property.id);
	const unitMap = new Map<string, { id: string; property_id: string }>(
		(unitRows ?? []).map((u) => [u.appfolio_unit_id, { id: u.id, property_id: u.property_id }])
	);

	// Fetch work orders for this ONE property from AppFolio.
	// The work_order API uses the property NUMBER (from the email subject), not the internal ID.
	// AppFolio's report API can lag behind email notifications by a few seconds,
	// so we retry up to 3 times with a delay when the WO isn't found yet.
	const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const propNumber = property.appfolio_property_number ?? appfolioPropertyId;
	const baseNumber = serviceRequestNumber.split('-')[0];
	const WO_RETRY_ATTEMPTS = 3;
	const WO_RETRY_DELAY_MS = 10_000;

	let row: any = null;
	for (let attempt = 1; attempt <= WO_RETRY_ATTEMPTS; attempt++) {
		const woRows = await appfolioFetch('work_order', {
			property_visibility: 'active',
			property: { property_id: propNumber },
			work_order_statuses: ['0', '1', '2', '9', '3', '6', '8', '12', '4', '5', '7'],
			status_date: '0',
			status_date_range_from: oneWeekAgo,
			columns: [
				'work_order_id', 'service_request_number', 'property_id', 'unit_id',
				'status', 'priority', 'job_description', 'service_request_description',
				'vendor_id', 'vendor', 'status_notes', 'created_at', 'work_order_type',
				'requesting_tenant', 'submitted_by_tenant',
				'primary_tenant', 'primary_tenant_email', 'primary_tenant_phone_number'
			]
		});

		// Find the specific work order matching the service request number.
		// The email subject may include a suffix like "7561-1" but the API returns "7561",
		// so we match on the base number (strip everything after the first dash).
		row = (woRows as any[]).find(
			(r: any) => String(r.service_request_number) === serviceRequestNumber
				|| String(r.service_request_number) === baseNumber
		);

		if (row) break;

		if (attempt < WO_RETRY_ATTEMPTS) {
			console.warn(`appfolio-email-trigger: WO #${serviceRequestNumber} not found in ${woRows.length} WOs for property ${appfolioPropertyId} — retrying in ${WO_RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${WO_RETRY_ATTEMPTS})`);
			await new Promise(r => setTimeout(r, WO_RETRY_DELAY_MS));
		} else {
			console.error(`appfolio-email-trigger: WO #${serviceRequestNumber} not found after ${WO_RETRY_ATTEMPTS} attempts (${woRows.length} WOs for property ${appfolioPropertyId})`);
			return Response.json({ ok: false, error: `Work order #${serviceRequestNumber} not found` }, { status: 404 });
		}
	}

	const woId = row.work_order_id;
	console.log(`appfolio-email-trigger: found work_order_id=${woId} for WO #${serviceRequestNumber}`);

	// Resolve unit
	let unitId: string | null = null;
	let propertyId: string = property.id;
	if (row.unit_id != null) {
		const unit = unitMap.get(String(row.unit_id));
		if (unit) {
			unitId = unit.id;
			propertyId = unit.property_id ?? propertyId;
		}
	}

	const description = row.job_description || row.service_request_description || null;
	const name = description
		? description.slice(0, 120)
		: `Work Order ${row.service_request_number ?? woId}`;
	const rawUrgent = (row.priority ?? '').toLowerCase() === 'urgent';

	// Check if issue already exists
	const { data: existingIssue } = await supabase
		.from('issues')
		.select('id, appfolio_raw_status, appfolio_vendor_id, appfolio_status_notes, vendor_assigned_at, vendor_followup_sent, urgent')
		.eq('workspace_id', workspaceId)
		.eq('appfolio_id', String(woId))
		.maybeSingle();

	// Upsert issue — ignoreDuplicates: true so existing issues keep agent-cleaned title/description
	const { data: upserted, error: upsertErr } = await supabase.from('issues').upsert(
		{
			workspace_id: workspaceId,
			source: 'appfolio',
			appfolio_id: String(woId),
			name,
			description: description ?? null,
			status: mapWorkOrderStatus(row.status ?? ''),
			urgent: rawUrgent,
			unit_id: unitId,
			property_id: propertyId
		},
		{ onConflict: 'workspace_id,appfolio_id', ignoreDuplicates: true }
	).select('id');

	if (upsertErr) {
		console.error(`appfolio-email-trigger: issue upsert error:`, upsertErr.message);
		return Response.json({ ok: false, error: upsertErr.message }, { status: 500 });
	}

	const issueId = existingIssue?.id ?? upserted?.[0]?.id ?? null;
	if (!issueId) {
		console.error('appfolio-email-trigger: could not resolve issue ID after upsert');
		return Response.json({ ok: false, error: 'Issue ID resolution failed' }, { status: 500 });
	}

	// Change detection
	const prev = existingIssue;
	const isNew = !prev;
	const statusChanged = !!prev && (prev.appfolio_raw_status ?? '') !== String(row.status ?? '');
	const vendorAssigned = !!prev && !prev.appfolio_vendor_id && row.vendor_id != null;
	const newNotes = (row.status_notes as string) || null;
	const notesChanged = !!prev && !!newNotes && newNotes !== (prev.appfolio_status_notes ?? '');
	const urgentChanged = !!prev && (prev.urgent ?? false) !== rawUrgent;

	// Update tracking columns if something changed
	if (isNew || statusChanged || vendorAssigned || notesChanged || urgentChanged) {
		const updateData: Record<string, any> = {
			appfolio_raw_status: String(row.status ?? ''),
			appfolio_status_notes: newNotes,
			appfolio_vendor_id: row.vendor_id != null ? String(row.vendor_id) : null,
			urgent: rawUrgent
		};
		if (vendorAssigned) {
			updateData.vendor_assigned_at = new Date().toISOString();
		}
		await supabase.from('issues').update(updateData).eq('id', issueId);
	}

	// Resolve tenant — prefer requesting_tenant (who actually submitted the WO)
	// over primary_tenant (first tenant on the lease, not necessarily the submitter)
	const emailParsed = parseAppfolioBody(emailBody ?? '');
	const tenantName = normalizeTenantName(
		(row.requesting_tenant as string) || (row.submitted_by_tenant as string) || (row.primary_tenant as string) || emailParsed.residentName || null
	);

	let tenantMatch: any = null;
	let tenantEmail: string | null = null;
	let tenantPhone: string | null = null;

	if (unitId && tenantName) {
		const { data } = await supabase
			.from('tenants')
			.select('id, email, phone')
			.eq('unit_id', unitId)
			.eq('name', tenantName)
			.limit(1)
			.maybeSingle();
		tenantMatch = data;
	}

	if (tenantMatch) {
		await supabase.from('issues').update({ tenant_id: tenantMatch.id }).eq('id', issueId);
		tenantEmail = tenantMatch.email ?? null;
		tenantPhone = tenantMatch.phone ?? null;
	} else {
		// Fallback to primary_tenant contact fields / email body parsing
		tenantEmail = (row.primary_tenant_email as string) || emailParsed.residentEmail || null;
		tenantPhone = normalizePhone((row.primary_tenant_phone_number as string) || emailParsed.residentPhone || null);
	}

	// Insert activity log for issue_created
	const logData: Record<string, any> = {
		source: 'appfolio',
		appfolio_id: String(woId),
		from: tenantName,
		from_email: tenantEmail,
		from_phone: tenantPhone,
		trigger: 'email'
	};
	if (gmailMessageId) logData.gmail_message_id = gmailMessageId;

	const { data: existingLog } = await supabase
		.from('activity_logs')
		.select('id')
		.eq('issue_id', issueId)
		.eq('type', 'issue_created')
		.maybeSingle();

	if (!existingLog) {
		const createdAt = row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString();
		await supabase.from('activity_logs').insert({
			workspace_id: workspaceId,
			issue_id: issueId,
			type: 'issue_created',
			created_at: createdAt,
			data: logData
		});
	}

	// Determine change type for agent dispatch
	let changeType: string | null = null;
	if (isNew) changeType = 'new';
	else if (statusChanged) changeType = 'status_changed';
	else if (vendorAssigned) changeType = 'vendor_assigned';
	else if (notesChanged) changeType = 'notes_changed';

	if (changeType) {
		// Enqueue durably
		const { error: queueErr } = await supabase.from('agent_dispatch_queue').insert({
			workspace_id: workspaceId,
			issue_id: issueId,
			change_type: changeType,
			row_data: row
		});
		if (queueErr && queueErr.code !== '23505') {
			console.error('appfolio-email-trigger: queue insert error:', queueErr.message);
		}

		// Process dispatch immediately
		if (changeType === 'new') {
			const runId = crypto.randomUUID();
			const { data: claimed } = await supabase.rpc('claim_issue_for_agent', {
				p_issue_id: issueId,
				p_run_id: runId,
				p_stale_minutes: 15
			});
			if (claimed) {
				console.log(`appfolio-email-trigger: claimed issue ${issueId} run=${runId}`);
				try {
					await dispatchToAgent({
						source: 'appfolio',
						issueId,
						workspaceId,
						change_type: changeType,
						row,
						run_id: runId
					});
					console.log(`appfolio-email-trigger: dispatched agent for issue ${issueId}`);
				} catch (err) {
					console.error(`appfolio-email-trigger: agent dispatch failed:`, err);
				}
			} else {
				console.log(`appfolio-email-trigger: issue ${issueId} already claimed — skipping dispatch`);
			}
		} else {
			try {
				await dispatchToAgent({
					source: 'appfolio',
					issueId,
					workspaceId,
					change_type: changeType,
					row
				});
			} catch (err) {
				console.error(`appfolio-email-trigger: agent dispatch failed:`, err);
			}
		}

		// Mark queue event as processed
		await supabase
			.from('agent_dispatch_queue')
			.update({ processed_at: new Date().toISOString() })
			.eq('issue_id', issueId)
			.eq('change_type', changeType)
			.is('processed_at', null);
	}

	console.log(`appfolio-email-trigger: done — issue=${issueId} change=${changeType ?? 'none'} isNew=${isNew}`);
	return Response.json({ ok: true, issueId, changeType, isNew });
});
