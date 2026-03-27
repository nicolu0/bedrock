// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Legacy JWT anon key — required by the gateway for project routing.
// The gateway validates `apikey` as a JWT; sb_secret_* and sb_publishable_* formats
// are NOT JWTs and will be rejected with 401 before the function runs.
// ANON_JWT is the legacy eyJhbG... key from Supabase → Settings → API.
const ANON_JWT = Deno.env.get('ANON_JWT')!;
// Shared secret for internal edge-function-to-edge-function calls.
// Validated inside the agent function; the gateway never inspects this header.
const INTERNAL_AGENT_KEY = Deno.env.get('INTERNAL_AGENT_KEY')!;
const APPFOLIO_CLIENT_ID = Deno.env.get('APPFOLIO_CLIENT_ID')!;
const APPFOLIO_CLIENT_SECRET = Deno.env.get('APPFOLIO_CLIENT_SECRET')!;
const APPFOLIO_VHOST = Deno.env.get('APPFOLIO_VHOST')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false }
});

// ── AppFolio API Helpers ──────────────────────────────────────────────────────

function appfolioUrl(reportName: string): string {
	// Credentials embedded in URL for HTTP Basic Auth per AppFolio conventions
	return `https://${APPFOLIO_CLIENT_ID}:${APPFOLIO_CLIENT_SECRET}@${APPFOLIO_VHOST}/api/v2/reports/${reportName}.json`;
}

async function appfolioFetch(
	urlOrReport: string,
	body: Record<string, unknown> = {},
	isPageUrl = false
): Promise<unknown[]> {
	const rows: unknown[] = [];
	// For next_page_url calls, the URL already has auth embedded (follows redirect from AppFolio)
	// For initial calls, we build the full auth URL
	let url: string | null = isPageUrl
		? urlOrReport
		: appfolioUrl(urlOrReport);
	let isFirst = true;

	while (url) {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: isFirst ? JSON.stringify(body) : JSON.stringify({})
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`AppFolio ${urlOrReport} ${res.status}: ${text}`);
		}

		const json = await res.json();

		// Support both paginated shape { results, next_page_url } and raw array shape
		if (Array.isArray(json)) {
			rows.push(...json);
			break;
		}

		rows.push(...(json.results ?? []));
		url = json.next_page_url ?? null;
		isFirst = false;
	}

	return rows;
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Address Abbreviation ──────────────────────────────────────────────────────

function abbreviateStreet(street: string): string {
	if (!street) return street;
	return street
		.replace(/\bStreet\b/gi, 'St')
		.replace(/\bAvenue\b/gi, 'Ave')
		.replace(/\bBoulevard\b/gi, 'Blvd')
		.replace(/\bPlace\b/gi, 'Pl')
		.replace(/\bDrive\b/gi, 'Dr')
		.replace(/\bCourt\b/gi, 'Ct')
		.replace(/\bLane\b/gi, 'Ln')
		.replace(/\bRoad\b/gi, 'Rd')
		.replace(/\bTerrace\b/gi, 'Ter')
		.replace(/\bCircle\b/gi, 'Cir');
}

// ── Work Order Status Mapping ─────────────────────────────────────────────────

// AppFolio returns status as a string label, not a numeric code.
// Numeric codes appear only in request filters (work_order_statuses).
function mapWorkOrderStatus(status: string): string {
	const s = (status ?? '').toLowerCase().trim();
	if (s === 'completed' || s === 'canceled' || s === 'completed no need to bill') {
		return 'done';
	}
	if (s === 'assigned' || s === 'scheduled' || s === 'waiting' || s === 'work done' || s === 'ready to bill') {
		return 'in_progress';
	}
	// New, Estimate Requested, Estimated, and anything unknown → todo
	return 'todo';
}

// ── Sync Functions ────────────────────────────────────────────────────────────

// Returns array of AppFolio property_id numbers synced for this workspace.
// If allowedIds is provided, only those properties are fetched and synced.
// Matches existing Bedrock properties by abbreviated street name (case-insensitive)
// rather than blindly upserting by appfolio_property_id.
async function syncProperties(workspaceId: string, allowedIds: number[] | null = null): Promise<number[]> {
	const body: Record<string, unknown> = {
		property_visibility: 'active',
		columns: ['property_id', 'property_name', 'property_address', 'property_street',
			'property_city', 'property_state', 'property_zip']
	};
	if (allowedIds?.length) {
		body.properties = { properties_ids: allowedIds.map(String) };
	}
	const rows = await appfolioFetch('property_directory', body);

	// Batch-fetch all existing Bedrock properties for this workspace upfront
	const { data: existingProps } = await supabase
		.from('properties')
		.select('id, name, address, appfolio_property_id')
		.eq('workspace_id', workspaceId);

	// Build lookup maps: normalized abbreviated name → property, normalized address → property
	const byName = new Map<string, any>();
	const byAddress = new Map<string, any>();
	for (const p of existingProps ?? []) {
		if (p.name) byName.set(abbreviateStreet(p.name).toLowerCase().trim(), p);
		// address stores the raw street only — index it abbreviated for matching
		if (p.address) byAddress.set(abbreviateStreet(p.address).toLowerCase().trim(), p);
	}

	const appfolioIds: number[] = [];

	for (const row of rows as any[]) {
		const propId = row.property_id;
		if (propId == null) continue;
		appfolioIds.push(Number(propId));

		const abbrevName = abbreviateStreet(row.property_street ?? '');
		// address = raw street only (no city/state/zip); city/state/postal_code go in their own columns
		const streetAddress = row.property_street || row.property_address || null;

		// Try to find an existing Bedrock property by abbreviated street name, then by raw street
		const nameKey = abbrevName.toLowerCase().trim();
		const addrKey = streetAddress?.toLowerCase().trim();
		const existing = (nameKey ? byName.get(nameKey) : null)
			?? (addrKey ? byAddress.get(addrKey) : null)
			?? null;

		const propertyFields = {
			name: abbrevName || existing?.name || (row.property_name ?? String(propId)),
			address: streetAddress ?? null,
			city: row.property_city ?? null,
			state: row.property_state ?? null,
			postal_code: row.property_zip ?? null,
			appfolio_property_id: String(propId)
		};

		if (existing) {
			const { error } = await supabase
				.from('properties')
				.update(propertyFields)
				.eq('id', existing.id);
			if (error) {
				console.error(`syncProperties update error for property_id=${propId}:`, error.message);
			}
		} else {
			const { error } = await supabase.from('properties').insert({
				workspace_id: workspaceId,
				...propertyFields
			});
			if (error) {
				console.error(`syncProperties insert error for property_id=${propId}:`, error.message);
			}
		}
	}

	return appfolioIds;
}

async function syncUnits(workspaceId: string, appfolioPropertyIds: number[]): Promise<void> {
	await sleep(500);

	// unit_directory filters properties_ids as array of strings
	const rows = await appfolioFetch('unit_directory', {
		unit_visibility: 'active',
		properties: { properties_ids: appfolioPropertyIds.map(String) },
		columns: ['unit_id', 'property_id', 'unit_name', 'unit_address',
			'unit_street', 'unit_city', 'unit_state', 'unit_zip',
			'sqft', 'bedrooms', 'bathrooms']
	});

	// Batch-fetch Bedrock property UUIDs by appfolio_property_id
	const { data: propRows } = await supabase
		.from('properties')
		.select('id, appfolio_property_id')
		.eq('workspace_id', workspaceId)
		.in('appfolio_property_id', appfolioPropertyIds.map(String));

	const propMap = new Map<string, string>(
		(propRows ?? []).map((p) => [p.appfolio_property_id, p.id])
	);

	// Batch-fetch all existing Bedrock units for these properties
	const bedrockPropertyIds = [...propMap.values()];
	const { data: unitRows } = bedrockPropertyIds.length
		? await supabase
			.from('units')
			.select('id, property_id, name, appfolio_unit_id')
			.in('property_id', bedrockPropertyIds)
		: { data: [] as any[] };

	// Build lookup: "${bedrockPropertyId}:${unitNameLower}" → unit
	const unitByNameAndProp = new Map<string, any>();
	for (const u of unitRows ?? []) {
		const key = `${u.property_id}:${(u.name ?? '').toLowerCase().trim()}`;
		unitByNameAndProp.set(key, u);
	}

	for (const row of rows as any[]) {
		const unitId = row.unit_id;
		const propId = row.property_id;
		if (unitId == null || propId == null) continue;

		const bedrockPropertyId = propMap.get(String(propId));
		if (!bedrockPropertyId) {
			console.warn(`syncUnits: no Bedrock property for appfolio_property_id=${propId}`);
			continue;
		}

		const unitName = row.unit_name ?? String(unitId);
		const lookupKey = `${bedrockPropertyId}:${unitName.toLowerCase().trim()}`;
		const existing = unitByNameAndProp.get(lookupKey);

		if (existing) {
			// Update existing unit's appfolio_unit_id if not already set
			if (existing.appfolio_unit_id !== String(unitId)) {
				const { error } = await supabase
					.from('units')
					.update({ appfolio_unit_id: String(unitId) })
					.eq('id', existing.id);
				if (error) {
					console.error(`syncUnits update error for unit_id=${unitId}:`, error.message);
				}
			}
		} else {
			// No name match — insert new unit
			const { error } = await supabase.from('units').upsert(
				{
					property_id: bedrockPropertyId,
					name: unitName,
					appfolio_unit_id: String(unitId)
				},
				{ onConflict: 'appfolio_unit_id', ignoreDuplicates: false }
			);
			if (error) {
				console.error(`syncUnits insert error for unit_id=${unitId}:`, error.message);
			}
		}
	}
}

async function syncTenants(workspaceId: string, appfolioPropertyIds: number[]): Promise<void> {
	await sleep(500);

	// Fetch financially-responsible (primary) tenants for current/notice leases.
	// Each row has unit_id which links back to appfolio_unit_id on the units table.
	const rows = await appfolioFetch('tenant_directory', {
		tenant_visibility: 'active',
		tenant_statuses: ['0', '4'], // Current and Notice
		tenant_types: ['0'],          // Financially Responsible (primary leaseholder)
		property_visibility: 'active',
		properties: { properties_ids: appfolioPropertyIds.map(String) },
		columns: ['unit_id', 'tenant', 'first_name', 'last_name', 'emails', 'phone_numbers']
	});

	for (const row of rows as any[]) {
		if (!row.unit_id) continue;

		// Prefer the pre-joined full name; fall back to first+last
		const name = row.tenant || [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
		// emails/phone_numbers may be comma-separated; take the first value
		const email = row.emails ? String(row.emails).split(',')[0].trim() || null : null;
		const phone = row.phone_numbers ? String(row.phone_numbers).split(',')[0].trim() || null : null;

		if (!name && !email && !phone) continue;

		const { error } = await supabase
			.from('units')
			.update({ tenant_name: name, tenant_email: email, tenant_phone: phone })
			.eq('appfolio_unit_id', String(row.unit_id));

		if (error) {
			console.error(`syncTenants update error for unit_id=${row.unit_id}:`, error.message);
		}
	}
}

async function syncVendors(workspaceId: string): Promise<void> {
	await sleep(500);

	const rows = await appfolioFetch('vendor_directory', {
		vendor_visibility: 'active',
		columns: ['vendor_id', 'company_name', 'name', 'vendor_trades', 'email', 'phone_numbers']
	});

	for (const row of rows as any[]) {
		const vendorId = row.vendor_id;
		if (vendorId == null) continue;

		const { error } = await supabase.from('vendors').upsert(
			{
				workspace_id: workspaceId,
				name: row.company_name || row.name || String(vendorId),
				trade: row.vendor_trades ?? null,
				appfolio_vendor_id: String(vendorId)
			},
			{ onConflict: 'workspace_id,appfolio_vendor_id', ignoreDuplicates: false }
		);
		if (error) {
			console.error(`syncVendors upsert error for vendor_id=${vendorId}:`, error.message);
		}
	}
}

async function syncWorkOrders(workspaceId: string, appfolioPropertyIds: number[]): Promise<void> {
	await sleep(500);

	// Batch-fetch all Bedrock property + unit mappings upfront
	const { data: propRows } = await supabase
		.from('properties')
		.select('id, appfolio_property_id')
		.eq('workspace_id', workspaceId)
		.in('appfolio_property_id', appfolioPropertyIds.map(String));
	const propMap = new Map<string, string>(
		(propRows ?? []).map((p) => [p.appfolio_property_id, p.id])
	);

	const { data: unitRows } = await supabase
		.from('units')
		.select('id, property_id, appfolio_unit_id')
		.not('appfolio_unit_id', 'is', null);
	const unitMap = new Map<string, { id: string; property_id: string }>(
		(unitRows ?? []).map((u) => [u.appfolio_unit_id, { id: u.id, property_id: u.property_id }])
	);

	// Batch-fetch all existing AppFolio issues — both for UUID lookup and change detection.
	// We grab tracking columns here so we can diff each work order against the prior sync
	// without an extra per-row query.
	const { data: existingIssueRows } = await supabase
		.from('issues')
		.select('id, appfolio_id, appfolio_raw_status, appfolio_vendor_id, appfolio_status_notes, vendor_assigned_at, vendor_followup_sent')
		.eq('workspace_id', workspaceId)
		.eq('source', 'appfolio')
		.not('appfolio_id', 'is', null);
	const existingIssueMap = new Map<string, string>(
		(existingIssueRows ?? []).map((r) => [String(r.appfolio_id), r.id])
	);
	const existingIssueIds = [...existingIssueMap.values()];
	// Snapshot keyed by Bedrock issue UUID for O(1) change detection per row.
	const snapshotById = new Map<string, any>(
		(existingIssueRows ?? []).map((r) => [r.id, r])
	);
	// Accumulated change events; fired to the agent in one batch after the property loop.
	const changeQueue: Array<{ issueId: string; workspaceId: string; change_type: string; row: any }> = [];

	// Batch-fetch existing issue_created logs with their data so we can:
	//   a) skip issues that already have a complete log (has 'from' field)
	//   b) backfill logs that exist but were created before we stored tenant info
	const issueIdsWithLog = new Set<string>();         // has any log → don't insert again
	const issueIdsNeedingFromUpdate = new Map<string, string>(); // issue_id → log.id for backfill
	if (existingIssueIds.length > 0) {
		const { data: logRows } = await supabase
			.from('activity_logs')
			.select('id, issue_id, data')
			.eq('type', 'issue_created')
			.in('issue_id', existingIssueIds);
		for (const logRow of logRows ?? []) {
			const iid = String(logRow.issue_id);
			issueIdsWithLog.add(iid);
			if (!logRow.data?.from) {
				issueIdsNeedingFromUpdate.set(iid, logRow.id);
			}
		}
	}

	// work_order endpoint takes exactly ONE property filter at a time
	for (const appfolioPropId of appfolioPropertyIds) {
		// Only pull work orders created on or after March 10, 2026 (pilot start date)
		const PILOT_START_DATE = '2026-03-10';

		let rows: unknown[];
		try {
			rows = await appfolioFetch('work_order', {
				property_visibility: 'active',
				property: { property_id: String(appfolioPropId) },
				work_order_statuses: ['0', '1', '2', '9', '3', '6', '8', '12', '4', '5', '7'],
				status_date: '0',               // filter by Created On
				status_date_range_from: PILOT_START_DATE,
				columns: [
					'work_order_id', 'service_request_number', 'property_id', 'unit_id',
					'status', 'priority', 'job_description', 'service_request_description',
					'vendor_id', 'vendor', 'status_notes', 'created_at', 'work_order_type',
					'primary_tenant', 'primary_tenant_email', 'primary_tenant_phone_number'
				]
			});
		} catch (err) {
			console.error(`syncWorkOrders fetch error for property_id=${appfolioPropId}:`, err);
			continue;
		}

		const bedrockPropertyId = propMap.get(String(appfolioPropId)) ?? null;

		for (const row of rows as any[]) {
			const woId = row.work_order_id;
			if (woId == null) continue;

			let unitId: string | null = null;
			let propertyId: string | null = bedrockPropertyId;
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

			const { data: upserted, error } = await supabase.from('issues').upsert(
				{
					workspace_id: workspaceId,
					source: 'appfolio',
					appfolio_id: String(woId),
					name,
					description: description ?? null,
					status: mapWorkOrderStatus(row.status ?? ''),
					urgent: (row.priority ?? '').toLowerCase() === 'urgent',
					unit_id: unitId,
					property_id: propertyId
				},
				{ onConflict: 'workspace_id,appfolio_id', ignoreDuplicates: false }
			).select('id');
			if (error) {
				console.error(`syncWorkOrders upsert error for work_order_id=${woId}:`, error.message);
				continue;
			}

			// Look up the issue UUID — prefer the pre-fetched map (works for existing
			// rows even if upsert RETURNING returns empty), fall back to upsert result
			// for genuinely new rows not in the map yet.
			const issueId = existingIssueMap.get(String(woId)) ?? upserted?.[0]?.id ?? null;
			if (issueId) existingIssueMap.set(String(woId), issueId); // cache for future iterations

			// Change detection — compare current AppFolio data against our last snapshot.
			// New issues (not in snapshot) always trigger 'new'; existing issues are diffed
			// field-by-field so we only fire agent events for actual changes.
			if (issueId) {
				const prev = snapshotById.get(issueId);
				const isNew = !prev;
				const statusChanged = !!prev && (prev.appfolio_raw_status ?? '') !== String(row.status ?? '');
				const vendorAssigned = !!prev && !prev.appfolio_vendor_id && row.vendor_id != null;
				const newNotes = (row.status_notes as string) || null;
				const notesChanged = !!prev && !!newNotes && newNotes !== (prev.appfolio_status_notes ?? '');

				// Persist tracking columns so future syncs can detect further changes.
				const updateData: Record<string, any> = {
					appfolio_raw_status: String(row.status ?? ''),
					appfolio_status_notes: newNotes,
					appfolio_vendor_id: row.vendor_id != null ? String(row.vendor_id) : null
				};
				if (vendorAssigned) {
					updateData.vendor_assigned_at = new Date().toISOString();
				}
				const { error: trackingError } = await supabase
					.from('issues')
					.update(updateData)
					.eq('id', issueId);
				if (trackingError) {
					console.error(`syncWorkOrders tracking update error for work_order_id=${woId}:`, trackingError.message);
				}

				if (isNew)          changeQueue.push({ issueId, workspaceId, change_type: 'new', row });
				if (statusChanged)  changeQueue.push({ issueId, workspaceId, change_type: 'status_changed', row });
				if (vendorAssigned) changeQueue.push({ issueId, workspaceId, change_type: 'vendor_assigned', row });
				if (notesChanged)   changeQueue.push({ issueId, workspaceId, change_type: 'notes_changed', row });
			}

			// Build tenant data from work order fields
			const tenantName = (row.primary_tenant as string) || null;
			const tenantEmail = (row.primary_tenant_email as string) || null;
			const tenantPhone = (row.primary_tenant_phone_number as string) || null;
			const logData = {
				source: 'appfolio',
				appfolio_id: String(woId),
				from: tenantName,
				from_email: tenantEmail,
				from_phone: tenantPhone
			};

			if (issueId && !issueIdsWithLog.has(issueId)) {
				// No log yet — insert
				issueIdsWithLog.add(issueId);
				const rawCreatedAt = row.created_at;
				const createdAt = rawCreatedAt ? new Date(rawCreatedAt).toISOString() : new Date().toISOString();
				const { error: logError } = await supabase.from('activity_logs').insert({
					workspace_id: workspaceId,
					issue_id: issueId,
					type: 'issue_created',
					created_at: createdAt,
					data: logData
				});
				if (logError) {
					console.error(`syncWorkOrders activity_log insert error for work_order_id=${woId}:`, logError.message);
				}
			} else if (issueId && issueIdsNeedingFromUpdate.has(issueId) && tenantName) {
				// Log exists but missing 'from' — backfill tenant info
				const logId = issueIdsNeedingFromUpdate.get(issueId)!;
				issueIdsNeedingFromUpdate.delete(issueId); // don't update again in same run
				const { error: updateError } = await supabase
					.from('activity_logs')
					.update({ data: logData })
					.eq('id', logId);
				if (updateError) {
					console.error(`syncWorkOrders activity_log backfill error for work_order_id=${woId}:`, updateError.message);
				}
			}
		}
	}

	// After all properties: check for overdue vendor follow-ups (>2h since assigned, no ack sent)
	const followupCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
	if (existingIssueIds.length > 0) {
		const { data: followupDue } = await supabase
			.from('issues')
			.select('id')
			.eq('workspace_id', workspaceId)
			.eq('source', 'appfolio')
			.eq('vendor_followup_sent', false)
			.not('vendor_assigned_at', 'is', null)
			.lt('vendor_assigned_at', followupCutoff);
		for (const issue of followupDue ?? []) {
			changeQueue.push({ issueId: issue.id, workspaceId, change_type: 'vendor_followup', row: null });
		}
	}

	// Fire-and-forget agent events for all detected changes.
	// Non-blocking — a failed agent call should never abort the sync.
	// The gateway requires `apikey` to be a valid JWT for project routing.
	// ANON_JWT is the legacy eyJhbG... anon key (not sb_secret_* or sb_publishable_* which are not JWTs).
	// verify_jwt:false in agent/config.json means the gateway won't reject the anon role.
	// x-internal-agent-key is validated inside the agent function to ensure only trusted callers proceed.
	for (const event of changeQueue) {
		fetch(`${SUPABASE_URL}/functions/v1/agent`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				apikey: ANON_JWT,
				Authorization: `Bearer ${ANON_JWT}`,
				'x-internal-agent-key': INTERNAL_AGENT_KEY
			},
			body: JSON.stringify({ source: 'appfolio', ...event })
		}).catch((err: Error) => console.error('appfolio-sync agent call failed:', err));
	}
}

// ── Main Handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
	const url = new URL(req.url);

	// ?test=1 — verify credentials with a minimal property_directory call
	if (url.searchParams.get('test') === '1') {
		try {
			const res = await fetch(appfolioUrl('property_directory'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					property_visibility: 'active',
					columns: ['property_id', 'property_name']
				})
			});
			const json = await res.json().catch(() => null);
			return Response.json({
				ok: res.ok,
				status: res.status,
				count: Array.isArray(json) ? json.length : (json?.results?.length ?? 0)
			});
		} catch (err) {
			return Response.json({ ok: false, error: String(err) }, { status: 500 });
		}
	}

	// ?debug=1 — fetch raw work order fields from AppFolio to inspect date formats (no DB writes)
	if (url.searchParams.get('debug') === '1') {
		try {
			const propRows = await appfolioFetch('property_directory', {
				property_visibility: 'active',
				columns: ['property_id', 'property_name']
			});
			const firstProp = (propRows as any[])[0];
			if (!firstProp?.property_id) {
				return Response.json({ ok: false, error: 'No properties found' });
			}
			const woRows = await appfolioFetch('work_order', {
				property_visibility: 'active',
				property: { property_id: String(firstProp.property_id) },
				work_order_statuses: ['0', '1', '2', '9', '3', '6', '8', '12', '4', '5', '7'],
				columns: [
					'work_order_id', 'service_request_number', 'created_at',
					'estimate_req_on', 'scheduled_start', 'completed_on',
					'status', 'priority', 'job_description'
				]
			});
			return Response.json({
				ok: true,
				property: { id: firstProp.property_id, name: firstProp.property_name },
				work_order_count: woRows.length,
				// Return first 5 raw rows so we can inspect date field formats
				sample: (woRows as any[]).slice(0, 5).map((r) => ({
					work_order_id: r.work_order_id,
					service_request_number: r.service_request_number,
					created_at: r.created_at,
					estimate_req_on: r.estimate_req_on,
					scheduled_start: r.scheduled_start,
					completed_on: r.completed_on,
					status: r.status,
					priority: r.priority,
					job_description: (r.job_description ?? '').slice(0, 60)
				}))
			});
		} catch (err) {
			return Response.json({ ok: false, error: String(err) }, { status: 500 });
		}
	}

	// ?discover=1 — return all AppFolio property IDs and names (no DB writes)
	if (url.searchParams.get('discover') === '1') {
		try {
			const rows = await appfolioFetch('property_directory', {
				property_visibility: 'active',
				columns: ['property_id', 'property_name']
			});
			return Response.json({
				ok: true,
				count: rows.length,
				properties: (rows as any[]).map((r) => ({ id: r.property_id, name: r.property_name }))
			});
		} catch (err) {
			return Response.json({ ok: false, error: String(err) }, { status: 500 });
		}
	}

	// Full sync — find all AppFolio-enabled workspaces and sync each one
	const { data: workspaces, error: wsError } = await supabase
		.from('workspaces')
		.select('id, appfolio_property_ids')
		.eq('appfolio_enabled', true);

	if (wsError) {
		return Response.json({ ok: false, error: wsError.message }, { status: 500 });
	}

	if (!workspaces?.length) {
		return Response.json({ ok: true, message: 'No AppFolio-enabled workspaces' });
	}

	const results: Record<string, unknown> = {};

	for (const ws of workspaces) {
		try {
			// If appfolio_property_ids is set, only sync those specific properties.
			// Otherwise fall back to syncing all active properties (not recommended).
			const allowedIds: number[] | null = ws.appfolio_property_ids?.length
				? ws.appfolio_property_ids.map(Number)
				: null;

			const appfolioPropertyIds = await syncProperties(ws.id, allowedIds);
			if (appfolioPropertyIds.length > 0) {
				await syncUnits(ws.id, appfolioPropertyIds);
				await syncTenants(ws.id, appfolioPropertyIds);
				// syncVendors skipped — vendors table not yet created
				await syncWorkOrders(ws.id, appfolioPropertyIds);
			}
			results[ws.id] = { ok: true, properties: appfolioPropertyIds.length };
		} catch (err) {
			console.error(`Sync failed for workspace ${ws.id}:`, err);
			results[ws.id] = { ok: false, error: String(err) };
		}
	}

	return Response.json({ ok: true, results });
});
