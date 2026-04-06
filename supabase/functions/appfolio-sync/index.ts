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

// ── Metrics ──────────────────────────────────────────────────────────────────

const metrics = {
	api_calls: 0,
	rate_limits_hit: 0,
	properties_processed: 0,
	work_orders_fetched: 0,
	events_queued: 0,
	dispatches_attempted: 0,
	dispatches_succeeded: 0,
	checkpoint_advanced: false,
};

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
		let res: Response | null = null;
		// 2 retries max with capped wait — the function runs every minute so fail fast
		// and let the next cron run pick up where we left off.
		for (let attempt = 1; attempt <= 2; attempt++) {
			res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: isFirst ? JSON.stringify(body) : JSON.stringify({})
			});
			if (res.status !== 429) break;
			metrics.rate_limits_hit++;
			const rawRetryAfter = Number(res.headers.get('retry-after') ?? (attempt * 3));
			const retryAfter = Math.min(rawRetryAfter, 8); // cap at 8s to avoid timeout
			const jitter = Math.floor(Math.random() * 1000);
			console.warn(`AppFolio ${urlOrReport} rate limited, retrying in ${retryAfter}s +${jitter}ms jitter (attempt ${attempt}/2)`);
			await new Promise(r => setTimeout(r, retryAfter * 1000 + jitter));
		}

		if (!res || !res.ok) {
			const text = await res?.text() ?? '';
			throw new Error(`AppFolio ${urlOrReport} ${res?.status}: ${text}`);
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

// ── Centralized Throttle ─────────────────────────────────────────────────────

// AppFolio rate limit: 7 requests per 15 seconds → 1 request every ~2.14s
const MIN_DELAY_MS = 2200;
// At 2.2s per request, ~25 properties fit within the 60s function timeout
const PROPERTIES_PER_RUN = 25;
let lastRequestTime = 0;

async function throttledAppfolioFetch(
	urlOrReport: string,
	body: Record<string, unknown> = {},
	isPageUrl = false
): Promise<unknown[]> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < MIN_DELAY_MS) {
		await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed));
	}
	lastRequestTime = Date.now();
	metrics.api_calls++;
	return appfolioFetch(urlOrReport, body, isPageUrl);
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

// ── Tenant Name Normalization ─────────────────────────────────────────────────

// AppFolio returns tenant names as "Last, First" (or "Last, First Middle").
// Normalize to "First Last" so names display naturally in the UI.
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
	const rawRows = await throttledAppfolioFetch('property_directory', body);
	// Filter in code as a safety net — the AppFolio API filter is not always respected
	const rows = allowedIds?.length
		? (rawRows as any[]).filter((r) => allowedIds.includes(Number(r.property_id)))
		: (rawRows as any[]);

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
			appfolio_property_id: String(propId),
			// property_name from AppFolio is the property NUMBER shown in the UI (e.g., "292").
			// The work_order API uses this number as its property filter, NOT the internal property_id.
			appfolio_property_number: row.property_name ? String(row.property_name) : null
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

	metrics.properties_processed += appfolioIds.length;
	return appfolioIds;
}

async function syncUnits(workspaceId: string, appfolioPropertyIds: number[]): Promise<void> {
	// unit_directory filters properties_ids as array of strings
	const rows = await throttledAppfolioFetch('unit_directory', {
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
					appfolio_unit_id: String(unitId),
					workspace_id: workspaceId
				},
				{ onConflict: 'appfolio_unit_id,workspace_id', ignoreDuplicates: false }
			);
			if (error) {
				console.error(`syncUnits insert error for unit_id=${unitId}:`, error.message);
			}
		}
	}
}

async function syncTenants(workspaceId: string, appfolioPropertyIds: number[]): Promise<void> {
	// Fetch ALL active tenants (all occupant types) for current/notice leases.
	// Unique constraint: (unit_id, email, name) NULLS NOT DISTINCT — covers tenants
	// with email, without email, or with neither.
	const rows = await throttledAppfolioFetch('tenant_directory', {
		tenant_visibility: 'active',
		tenant_statuses: ['0', '4'], // Current and Notice
		property_visibility: 'active',
		properties: { properties_ids: appfolioPropertyIds.map(String) },
		columns: ['unit_id', 'tenant', 'first_name', 'last_name', 'emails', 'phone_numbers']
	});

	// Fetch workspace admin_user_id — required as non-null FK on tenants rows.
	const { data: workspace } = await supabase
		.from('workspaces')
		.select('admin_user_id')
		.eq('id', workspaceId)
		.single();
	const adminUserId = workspace?.admin_user_id;
	if (!adminUserId) {
		console.error(`syncTenants: could not resolve admin_user_id for workspace ${workspaceId}`);
		return;
	}

	// Build appfolio_unit_id → bedrock unit.id map for FK resolution.
	const { data: unitRows } = await supabase
		.from('units')
		.select('id, appfolio_unit_id')
		.not('appfolio_unit_id', 'is', null);
	const unitIdMap = new Map<string, string>(
		(unitRows ?? []).map((u: any) => [u.appfolio_unit_id, u.id])
	);

	// First pass: collect all affected bedrock unit IDs so we can fetch existing tenants.
	const affectedBedrockUnitIds = new Set<string>();
	for (const row of rows as any[]) {
		if (!row.unit_id) continue;
		const bedrockUnitId = unitIdMap.get(String(row.unit_id));
		if (bedrockUnitId) affectedBedrockUnitIds.add(bedrockUnitId);
	}

	// Fetch ALL existing tenants in affected units at once — used for change detection
	// and stale deletion.
	const { data: existingTenants, error: fetchErr } = affectedBedrockUnitIds.size > 0
		? await supabase
			.from('tenants')
			.select('id, unit_id, email, name, phone')
			.in('unit_id', [...affectedBedrockUnitIds])
		: { data: [] as any[], error: null };
	if (fetchErr) {
		console.error('syncTenants existing fetch error:', fetchErr.message);
	}

	// Lookup map keyed by (unit_id, email, name) — matches the unique constraint.
	// email is lowercased; name is normalized. NULLS are included in the key as empty
	// string so null::null maps to a unique string.
	const existingByKey = new Map<string, any>(
		(existingTenants ?? []).map((t: any) => [
			`${t.unit_id}::${(t.email ?? '').toLowerCase()}::${t.name ?? ''}`,
			t
		])
	);

	// toUpsertMap deduplicates by (unit_id, email, name) within the batch.
	// PostgreSQL rejects ON CONFLICT DO UPDATE when the same conflict key appears
	// more than once in a single statement.
	const toUpsertMap = new Map<string, any>(); // key: unit_id::email::name
	const seenKeys = new Set<string>(); // for stale detection

	for (const row of rows as any[]) {
		if (!row.unit_id) continue;
		const bedrockUnitId = unitIdMap.get(String(row.unit_id));
		if (!bedrockUnitId) continue;

		// Prefer the pre-joined full name; fall back to first+last. Normalize "Last, First" → "First Last".
		const name = normalizeTenantName(row.tenant || [row.first_name, row.last_name].filter(Boolean).join(' ') || null);
		// emails/phone_numbers may be comma-separated; take the first value. Normalize email to lowercase.
		const rawEmail = row.emails ? String(row.emails).split(',')[0].trim() || null : null;
		const email = rawEmail ? rawEmail.toLowerCase() : null;
		const phone = row.phone_numbers ? String(row.phone_numbers).split(',')[0].trim() || null : null;

		const key = `${bedrockUnitId}::${email ?? ''}::${name ?? ''}`;
		seenKeys.add(key);

		// Skip write if phone is the only thing and it's unchanged (name+email are the conflict key).
		const existing = existingByKey.get(key);
		if (existing && (existing.phone ?? null) === (phone ?? null)) continue;

		toUpsertMap.set(key, { user_id: adminUserId, unit_id: bedrockUnitId, name, email, phone });
	}

	// Batch upsert all tenants in chunks of 50.
	const toUpsert = [...toUpsertMap.values()];
	const CHUNK = 50;
	for (let i = 0; i < toUpsert.length; i += CHUNK) {
		const chunk = toUpsert.slice(i, i + CHUNK);
		const { error } = await supabase
			.from('tenants')
			.upsert(chunk, { onConflict: 'unit_id,email,name', ignoreDuplicates: false });
		if (error) {
			console.error(`syncTenants upsert error (chunk ${Math.floor(i / CHUNK)}):`, error.message);
		}
	}

	// Stale delete: remove tenants no longer returned by AppFolio.
	const staleIds = (existingTenants ?? [])
		.filter((t: any) => {
			const key = `${t.unit_id}::${(t.email ?? '').toLowerCase()}::${t.name ?? ''}`;
			return !seenKeys.has(key);
		})
		.map((t: any) => t.id);
	if (staleIds.length > 0) {
		const { error: delErr } = await supabase.from('tenants').delete().in('id', staleIds);
		if (delErr) console.error('syncTenants stale delete error:', delErr.message);
	}

	if (toUpsert.length > 0 || staleIds.length > 0) {
		console.log(`syncTenants: ${toUpsert.length} upserted, ${staleIds.length} deleted`);
	}
}

async function syncVendors(workspaceId: string, seenVendorIds: string[]): Promise<void> {
	// Vendor IDs are accumulated from work orders during the fast-path sync.
	// We only need to call vendor_directory once, filtered to those IDs.
	const activeVendorIds = new Set(seenVendorIds);

	if (activeVendorIds.size === 0) {
		console.log('syncVendors: no accumulated vendor IDs — skipping');
		return;
	}

	// Fetch all active vendors from AppFolio and filter to those seen on work orders
	const rows = await throttledAppfolioFetch('vendor_directory', {
		vendor_visibility: 'active',
		columns: ['vendor_id', 'company_name', 'name', 'vendor_trades', 'email', 'phone_numbers', 'street', 'city', 'state', 'zip']
	});

	const filtered = (rows as any[]).filter(
		(r) => r.vendor_id != null && activeVendorIds.has(String(r.vendor_id))
	);

	for (const row of filtered) {
		const vendorId = row.vendor_id;
		const { error } = await supabase.from('vendors').upsert(
			{
				workspace_id: workspaceId,
				appfolio_vendor_id: String(vendorId),
				name: row.company_name || row.name || String(vendorId),
				trade: row.vendor_trades ?? null,
				email: row.email ? String(row.email).split(',')[0].trim() || null : null,
				phone: row.phone_numbers ? String(row.phone_numbers).split(',')[0].trim() || null : null,
				street: row.street ?? null,
				city: row.city ?? null,
				state: row.state ?? null,
				zip: row.zip ?? null
			},
			{ onConflict: 'workspace_id,appfolio_vendor_id', ignoreDuplicates: false }
		);
		if (error) {
			console.error(`syncVendors upsert error for vendor_id=${vendorId}:`, error.message);
		}
	}

	// Clear the accumulator now that vendor sync is complete
	await supabase
		.from('workspaces')
		.update({ appfolio_seen_vendor_ids: [] })
		.eq('id', workspaceId);

	console.log(`syncVendors: synced ${filtered.length} vendors (${activeVendorIds.size} IDs accumulated from work orders)`);
}

// ── Enqueue Helper ────────────────────────────────────────────────────────────

async function enqueueAgentEvent(
	workspaceId: string,
	issueId: string,
	changeType: string,
	row: any
): Promise<void> {
	// Plain insert — the partial unique index (issue_id, change_type) WHERE processed_at IS NULL
	// rejects duplicates with a 23505 error, which we treat as a no-op (event already queued).
	const { error } = await supabase.from('agent_dispatch_queue').insert({
		workspace_id: workspaceId,
		issue_id: issueId,
		change_type: changeType,
		row_data: row
	});
	if (error) {
		if (error.code === '23505') {
			// Already queued — expected, skip silently
			return;
		}
		console.error(`enqueueAgentEvent error for issue=${issueId} type=${changeType}:`, error.message);
	} else {
		metrics.events_queued++;
	}
}

// ── Work Order Sync (Fast Path) ──────────────────────────────────────────────

async function syncWorkOrders(
	workspaceId: string,
	appfolioPropertyIds: number[],
	lastSyncAt: string | null,
	isFullCycle = false
): Promise<void> {
	// Batch-fetch all Bedrock property + unit mappings upfront
	const { data: propRows } = await supabase
		.from('properties')
		.select('id, appfolio_property_id, appfolio_property_number')
		.eq('workspace_id', workspaceId)
		.in('appfolio_property_id', appfolioPropertyIds.map(String));
	// propMap: internal appfolio_property_id → bedrock UUID
	const propMap = new Map<string, string>(
		(propRows ?? []).map((p) => [p.appfolio_property_id, p.id])
	);
	// propNumberMap: internal appfolio_property_id → property number (used by work_order API)
	const propNumberMap = new Map<string, string>(
		(propRows ?? []).filter((p) => p.appfolio_property_number).map((p) => [p.appfolio_property_id, p.appfolio_property_number])
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
		.select('id, appfolio_id, appfolio_raw_status, appfolio_vendor_id, appfolio_status_notes, vendor_assigned_at, vendor_followup_sent, urgent')
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

	// Incremental sync window: use last successful checkpoint minus 5-min overlap,
	// or fall back to pilot start date on first run.
	const PILOT_START_DATE = '2026-03-20';
	const OVERLAP_BUFFER_MS = 5 * 60 * 1000;
	let syncFromDate: string;
	if (lastSyncAt) {
		syncFromDate = new Date(new Date(lastSyncAt).getTime() - OVERLAP_BUFFER_MS)
			.toISOString().slice(0, 10);
	} else {
		syncFromDate = PILOT_START_DATE;
	}
	console.log(`syncWorkOrders: window from ${syncFromDate} (checkpoint: ${lastSyncAt ?? 'none'})`);

	// Accumulate vendor IDs from work orders for the slow-path vendor sync
	const seenVendorIds = new Set<string>();
	let allPropertiesSucceeded = true;

	// work_order endpoint takes exactly ONE property filter at a time.
	// IMPORTANT: The work_order API uses the property NUMBER (e.g., "292") as its filter,
	// NOT the internal property_id (e.g., "202") from property_directory.
	for (const appfolioPropId of appfolioPropertyIds) {
		// Look up the property number for the work_order API
		const propNumber = propNumberMap.get(String(appfolioPropId));
		if (!propNumber) {
			console.warn(`syncWorkOrders: no appfolio_property_number for appfolio_property_id=${appfolioPropId} — skipping`);
			continue;
		}

		let allRows: unknown[];
		try {
			allRows = await throttledAppfolioFetch('work_order', {
				property_visibility: 'active',
				property: { property_id: propNumber },
				work_order_statuses: ['0', '1', '2', '9', '3', '6', '8', '12', '4', '5', '7'],
				// API-level date filter to reduce data volume (not fully reliable,
				// but prevents fetching years of history). Client-side filter below
				// is the source of truth.
				status_date: '0',
				status_date_range_from: syncFromDate,
				columns: [
					'work_order_id', 'service_request_number', 'property_id', 'unit_id',
					'status', 'priority', 'job_description', 'service_request_description',
					'vendor_id', 'vendor', 'status_notes', 'created_at', 'work_order_type',
					'primary_tenant', 'primary_tenant_email', 'primary_tenant_phone_number'
				]
			});
		} catch (err) {
			// 500 errors typically mean this is a non-property entity (payroll account, HOA, etc.)
			// that AppFolio lists in property_directory but can't have work orders.
			// Treat as a skip, not a failure that blocks checkpoint advancement.
			const is500 = String(err).includes('500');
			if (is500) {
				console.warn(`syncWorkOrders: skipping non-property entity ${propNumber} (id=${appfolioPropId}): 500 error`);
			} else {
				console.error(`syncWorkOrders fetch failed for property ${propNumber} (id=${appfolioPropId}):`, err);
				allPropertiesSucceeded = false;
			}
			continue;
		}

		// Client-side date filter — only process work orders created on or after syncFromDate
		const rows = (allRows as any[]).filter(r => r.created_at && r.created_at >= syncFromDate);
		metrics.work_orders_fetched += rows.length;

		const bedrockPropertyId = propMap.get(String(appfolioPropId)) ?? null;
		if (!bedrockPropertyId) {
			console.warn(`syncWorkOrders: no Bedrock property for appfolio_property_id=${appfolioPropId} — skipping ${(rows as any[]).length} work orders`);
			continue;
		}

		for (const row of rows as any[]) {
			const woId = row.work_order_id;
			if (woId == null) continue;

			// Accumulate vendor IDs for slow-path vendor sync
			if (row.vendor_id != null) seenVendorIds.add(String(row.vendor_id));

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

			const rawUrgent = (row.priority ?? '').toLowerCase() === 'urgent';

			// ignoreDuplicates: true — existing issues keep their agent-cleaned title/description.
			// Tracking columns (status, vendor, notes, urgent) are updated separately below.
			const { data: upserted, error } = await supabase.from('issues').upsert(
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

				// Persist tracking columns only when something actually changed.
				// Avoids writing to issues (Realtime-subscribed) on every sync unnecessarily.
				const urgentChanged = !!prev && (prev.urgent ?? false) !== rawUrgent;
				const shouldUpdateTracking = isNew || statusChanged || vendorAssigned || notesChanged || urgentChanged;
				if (shouldUpdateTracking) {
					const updateData: Record<string, any> = {
						appfolio_raw_status: String(row.status ?? ''),
						appfolio_status_notes: newNotes,
						appfolio_vendor_id: row.vendor_id != null ? String(row.vendor_id) : null,
						urgent: rawUrgent
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
				}

				// Enqueue change events durably to the agent_dispatch_queue table
				if (isNew) {
					await enqueueAgentEvent(workspaceId, issueId, 'new', row);
				}
				if (statusChanged) await enqueueAgentEvent(workspaceId, issueId, 'status_changed', row);
				if (vendorAssigned) await enqueueAgentEvent(workspaceId, issueId, 'vendor_assigned', row);
				if (notesChanged) await enqueueAgentEvent(workspaceId, issueId, 'notes_changed', row);
			}

			// Build tenant data from work order fields
			const tenantName = normalizeTenantName((row.primary_tenant as string) || null);
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
			await enqueueAgentEvent(workspaceId, issue.id, 'vendor_followup', null);
		}
	}

	// Re-queue issues that are pending, failed, or stuck in processing (stale >15 min).
	// The atomic claim RPC prevents duplicate agent runs even if multiple syncs overlap.
	if (existingIssueIds.length > 0) {
		const { data: retryIssues } = await supabase
			.from('issues')
			.select('id')
			.eq('workspace_id', workspaceId)
			.eq('source', 'appfolio')
			.in('agent_status', ['pending', 'failed'])
			.in('id', existingIssueIds);

		const staleThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();
		const { data: staleIssues } = await supabase
			.from('issues')
			.select('id')
			.eq('workspace_id', workspaceId)
			.eq('source', 'appfolio')
			.eq('agent_status', 'processing')
			.lt('agent_started_at', staleThreshold)
			.in('id', existingIssueIds);

		for (const issue of [...(retryIssues ?? []), ...(staleIssues ?? [])]) {
			await enqueueAgentEvent(workspaceId, issue.id, 'new', null);
		}
		const retryCount = (retryIssues?.length ?? 0) + (staleIssues?.length ?? 0);
		if (retryCount > 0) {
			console.log(`syncWorkOrders: re-queuing ${retryCount} unprocessed issues (${staleIssues?.length ?? 0} stale)`);
		}
	}

	// Merge accumulated vendor IDs into workspace for slow-path vendor sync
	if (seenVendorIds.size > 0) {
		const { data: ws } = await supabase
			.from('workspaces')
			.select('appfolio_seen_vendor_ids')
			.eq('id', workspaceId)
			.single();
		const existing = new Set(ws?.appfolio_seen_vendor_ids ?? []);
		for (const vid of seenVendorIds) existing.add(vid);
		await supabase
			.from('workspaces')
			.update({ appfolio_seen_vendor_ids: [...existing] })
			.eq('id', workspaceId);
	}

	// Advance checkpoint only when we've completed a full cycle through all properties
	// AND all properties in this batch succeeded. This ensures every property has been
	// synced at least once before we narrow the time window.
	if (isFullCycle && allPropertiesSucceeded) {
		await supabase
			.from('workspaces')
			.update({ last_work_order_sync_at: new Date().toISOString() })
			.eq('id', workspaceId);
		metrics.checkpoint_advanced = true;
		console.log('syncWorkOrders: full cycle complete — checkpoint advanced');
	} else if (!allPropertiesSucceeded) {
		console.warn('syncWorkOrders: some properties failed — checkpoint NOT advanced');
	}
}

// ── Agent Dispatch (Durable Queue) ───────────────────────────────────────────

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

const CHANGE_PRIORITY: Record<string, number> = {
	new: 5,
	vendor_assigned: 4,
	status_changed: 3,
	notes_changed: 2,
	vendor_followup: 1
};

async function processDispatchQueue(workspaceId: string): Promise<void> {
	// Fetch unprocessed events, skipping anything older than 24 hours
	const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const { data: pending } = await supabase
		.from('agent_dispatch_queue')
		.select('*')
		.eq('workspace_id', workspaceId)
		.is('processed_at', null)
		.gt('created_at', cutoff)
		.order('created_at', { ascending: true })
		.limit(8); // Cap per run — 8 dispatches × 6s = 48s, fits in 60s timeout

	if (!pending?.length) return;

	// Coalesce: keep highest-priority event per issue_id
	const coalesced = new Map<string, typeof pending[0]>();
	for (const event of pending) {
		const existing = coalesced.get(event.issue_id);
		if (!existing || (CHANGE_PRIORITY[event.change_type] ?? 0) > (CHANGE_PRIORITY[existing.change_type] ?? 0)) {
			coalesced.set(event.issue_id, event);
		}
	}

	// Claim all 'new' events first (sequential — needs DB round-trip), then dispatch all in parallel.
	const toDispatch: Array<{ event: typeof pending[0]; runId?: string }> = [];
	for (const event of coalesced.values()) {
		metrics.dispatches_attempted++;
		if (event.change_type === 'new') {
			const runId = crypto.randomUUID();
			const { data: claimed } = await supabase.rpc('claim_issue_for_agent', {
				p_issue_id: event.issue_id,
				p_run_id: runId,
				p_stale_minutes: 15
			});
			if (!claimed) {
				console.log(`dispatch: skip ${event.issue_id} — already claimed or processing`);
				continue;
			}
			console.log(`dispatch: claimed issue ${event.issue_id} run=${runId}`);
			toDispatch.push({ event, runId });
		} else {
			toDispatch.push({ event });
		}
	}

	// Dispatch one at a time with 6s gaps to stay under OpenAI's 500k TPM limit
	// (~40k tokens per agent call × 10 calls/min = 400k TPM, safely under 500k).
	// In normal operation (email trigger), only 1 issue is dispatched so this loop
	// only matters for backfills.
	for (let i = 0; i < toDispatch.length; i++) {
		const { event, runId } = toDispatch[i];
		dispatchToAgent({
			source: 'appfolio',
			issueId: event.issue_id,
			workspaceId: event.workspace_id,
			change_type: event.change_type,
			row: event.row_data,
			...(runId ? { run_id: runId } : {})
		}).then(() => {
			metrics.dispatches_succeeded++;
		}).catch(err => {
			console.error(`dispatch error for issue ${event.issue_id}:`, err);
		});
		console.log(`dispatch: fired ${i + 1}/${toDispatch.length} — issue ${event.issue_id}`);
		if (i < toDispatch.length - 1) {
			await new Promise(r => setTimeout(r, 6000));
		}
	}

	// Mark ALL fetched events as processed (including lower-priority coalesced-away ones)
	const allIds = pending.map(e => e.id);
	await supabase
		.from('agent_dispatch_queue')
		.update({ processed_at: new Date().toISOString() })
		.in('id', allIds);
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

	// ?debug=2 — test work_order fetch WITH date filter. Use &prop=292 to test a specific property.
	if (url.searchParams.get('debug') === '2') {
		try {
			const testDate = url.searchParams.get('from') ?? '2026-03-30';
			const specificProp = url.searchParams.get('prop');
			let testProps: any[];

			if (specificProp) {
				testProps = [{ property_id: Number(specificProp), property_name: specificProp }];
			} else {
				const propRows = await appfolioFetch('property_directory', {
					property_visibility: 'active',
					columns: ['property_id', 'property_name']
				});
				testProps = (propRows as any[]).slice(0, 3);
			}
			const results: any[] = [];

			for (const prop of testProps) {
				// With date filter (status_date: '0' = supposedly "Created On")
				// Fetch WITHOUT date filter to get raw data
				const allWo = await throttledAppfolioFetch('work_order', {
					property_visibility: 'active',
					property: { property_id: String(prop.property_id) },
					work_order_statuses: ['0', '1', '2', '9', '3', '6', '8', '12', '4', '5', '7'],
					columns: [
						'work_order_id', 'service_request_number', 'created_at',
						'status', 'priority', 'job_description',
						'estimate_req_on', 'scheduled_start', 'completed_on'
					]
				});
				// Show the 5 NEWEST by work_order_id (highest IDs = most recent)
				const sorted = (allWo as any[]).sort((a, b) => (b.work_order_id ?? 0) - (a.work_order_id ?? 0));
				results.push({
					property_id: prop.property_id,
					name: prop.property_name,
					total_wo: allWo.length,
					newest_5: sorted.slice(0, 5).map(r => ({
						work_order_id: r.work_order_id,
						service_request_number: r.service_request_number,
						created_at: r.created_at,
						status: r.status,
						priority: r.priority,
						job_description: (r.job_description ?? '').slice(0, 60)
					}))
				});
			}
			return Response.json({ ok: true, test_date: testDate, results });
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

	// ── Sync modes ───────────────────────────────────────────────────────────
	// Default (no mode param): fast path — work orders + agent dispatch (every minute)
	// ?mode=metadata: slow path — properties, units, tenants, vendors (every 6 hours)

	const mode = url.searchParams.get('mode');

	const { data: workspaces, error: wsError } = await supabase
		.from('workspaces')
		.select('id, appfolio_property_ids, last_work_order_sync_at, last_metadata_sync_at, appfolio_seen_vendor_ids, sync_property_cursor')
		.eq('appfolio_enabled', true);

	if (wsError) {
		return Response.json({ ok: false, error: wsError.message }, { status: 500 });
	}

	if (!workspaces?.length) {
		return Response.json({ ok: true, message: 'No AppFolio-enabled workspaces' });
	}

	const results: Record<string, unknown> = {};

	for (const ws of workspaces) {
		// If appfolio_property_ids is set, only sync those specific properties.
		// Otherwise fall back to syncing all active properties.
		const allowedIds: number[] | null = ws.appfolio_property_ids?.length
			? ws.appfolio_property_ids.map(Number)
			: null;

		if (!allowedIds || allowedIds.length === 0) {
			console.warn(`Workspace ${ws.id}: no appfolio_property_ids configured — syncing all active properties`);
		}

		try {
			if (mode === 'metadata') {
				// SLOW PATH: properties, units, tenants, vendors
				const appfolioPropertyIds = await syncProperties(ws.id, allowedIds);
				if (appfolioPropertyIds.length > 0) {
					await syncUnits(ws.id, appfolioPropertyIds);
					await syncTenants(ws.id, appfolioPropertyIds);
					await syncVendors(ws.id, ws.appfolio_seen_vendor_ids ?? []);
				}
				await supabase
					.from('workspaces')
					.update({ last_metadata_sync_at: new Date().toISOString() })
					.eq('id', ws.id);

				// Clean up old processed dispatch queue events
				await supabase
					.from('agent_dispatch_queue')
					.delete()
					.eq('workspace_id', ws.id)
					.not('processed_at', 'is', null)
					.lt('processed_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

				results[ws.id] = { ok: true, properties: appfolioPropertyIds.length };
			} else {
				// FAST PATH: work orders + agent dispatch
				// Process properties in batches using a round-robin cursor to stay within
				// the function timeout. With 68 properties and 300ms throttle, processing
				// all at once would take ~20s for spacing alone plus request time.
				let allPropertyIds: number[];
				if (allowedIds) {
					allPropertyIds = allowedIds;
				} else {
					const { data: props } = await supabase
						.from('properties')
						.select('appfolio_property_id')
						.eq('workspace_id', ws.id)
						.not('appfolio_property_id', 'is', null);
					allPropertyIds = (props ?? []).map(p => Number(p.appfolio_property_id));
				}

				if (allPropertyIds.length > 0) {
					// Sort deterministically so cursor position is stable across runs
					allPropertyIds.sort((a, b) => a - b);

					const cursor = ws.sync_property_cursor ?? 0;
					const batch = allPropertyIds.slice(cursor, cursor + PROPERTIES_PER_RUN);
					const nextCursor = cursor + PROPERTIES_PER_RUN >= allPropertyIds.length ? 0 : cursor + PROPERTIES_PER_RUN;
					const isFullCycle = nextCursor === 0 && batch.length > 0;

					console.log(`fast-path: properties ${cursor}..${cursor + batch.length - 1} of ${allPropertyIds.length} (batch=${batch.length}, next_cursor=${nextCursor})`);

					await syncWorkOrders(ws.id, batch, ws.last_work_order_sync_at, isFullCycle);

					// Advance cursor
					await supabase
						.from('workspaces')
						.update({ sync_property_cursor: nextCursor })
						.eq('id', ws.id);

					await processDispatchQueue(ws.id);

					results[ws.id] = { ok: true, batch: batch.length, total_properties: allPropertyIds.length, cursor: nextCursor };
				} else {
					console.warn(`Workspace ${ws.id}: no properties to sync work orders for`);
					results[ws.id] = { ok: true, batch: 0, total_properties: 0 };
				}
			}
		} catch (err) {
			console.error(`Sync (${mode ?? 'fast'}) failed for workspace ${ws.id}:`, err);
			results[ws.id] = { ok: false, error: String(err) };
		}
	}

	console.log(`appfolio-sync [${mode ?? 'fast'}] metrics:`, JSON.stringify(metrics));
	return Response.json({ ok: true, mode: mode ?? 'fast', metrics, results });
});
