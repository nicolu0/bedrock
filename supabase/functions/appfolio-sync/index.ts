// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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

// ── Work Order Status Mapping ─────────────────────────────────────────────────

// AppFolio returns status as a string label, not a numeric code.
// Numeric codes appear only in request filters (work_order_statuses).
function mapWorkOrderStatus(status: string): string {
	const s = (status ?? '').toLowerCase().trim();
	if (s === 'completed' || s === 'canceled' || s === 'completed no need to bill') {
		return 'closed';
	}
	if (s === 'assigned' || s === 'scheduled' || s === 'waiting' || s === 'work done' || s === 'ready to bill') {
		return 'in_progress';
	}
	// New, Estimate Requested, Estimated, and anything unknown → open
	return 'open';
}

// ── Sync Functions ────────────────────────────────────────────────────────────

// Returns array of AppFolio property_id numbers synced for this workspace.
// If allowedIds is provided, only those properties are fetched and upserted.
async function syncProperties(workspaceId: string, allowedIds: number[] | null = null): Promise<number[]> {
	const body: Record<string, unknown> = {
		property_visibility: 'active',
		columns: ['property_id', 'property_name', 'property_address', 'property_street',
			'property_city', 'property_state', 'property_zip']
	};
	// Filter to assigned properties only if specified
	if (allowedIds?.length) {
		body.properties = { properties_ids: allowedIds.map(String) };
	}
	const rows = await appfolioFetch('property_directory', body);

	const appfolioIds: number[] = [];

	for (const row of rows as any[]) {
		const propId = row.property_id;
		if (propId == null) continue;
		appfolioIds.push(Number(propId));

		const address = [
			row.property_street,
			row.property_city,
			row.property_state,
			row.property_zip
		].filter(Boolean).join(', ') || row.property_address || null;

		const { error } = await supabase.from('properties').upsert(
			{
				workspace_id: workspaceId,
				name: row.property_name ?? String(propId),
				address: address ?? null,
				appfolio_property_id: String(propId)
			},
			{ onConflict: 'workspace_id,appfolio_property_id', ignoreDuplicates: false }
		);
		if (error) {
			console.error(`syncProperties upsert error for property_id=${propId}:`, error.message);
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

	for (const row of rows as any[]) {
		const unitId = row.unit_id;
		const propId = row.property_id;
		if (unitId == null || propId == null) continue;

		// Look up the Bedrock property UUID by appfolio_property_id
		const { data: prop } = await supabase
			.from('properties')
			.select('id')
			.eq('workspace_id', workspaceId)
			.eq('appfolio_property_id', String(propId))
			.maybeSingle();

		if (!prop?.id) {
			console.warn(`syncUnits: no Bedrock property for appfolio_property_id=${propId}`);
			continue;
		}

		const { error } = await supabase.from('units').upsert(
			{
				property_id: prop.id,
				name: row.unit_name ?? String(unitId),
				appfolio_unit_id: String(unitId)
			},
			{ onConflict: 'appfolio_unit_id', ignoreDuplicates: false }
		);
		if (error) {
			console.error(`syncUnits upsert error for unit_id=${unitId}:`, error.message);
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

	// work_order endpoint takes exactly ONE property filter at a time
	for (const appfolioPropId of appfolioPropertyIds) {
		let rows: unknown[];
		try {
			rows = await appfolioFetch('work_order', {
				property_visibility: 'active',
				property: { property_id: String(appfolioPropId) },
				// Default statuses cover all active work orders; include completed for updates
				work_order_statuses: ['0', '1', '2', '9', '3', '6', '8', '12', '4', '5', '7'],
				columns: [
					'work_order_id', 'service_request_number', 'property_id', 'unit_id',
					'status', 'priority', 'job_description', 'service_request_description',
					'vendor_id', 'created_at', 'work_order_type'
				]
			});
		} catch (err) {
			console.error(`syncWorkOrders fetch error for property_id=${appfolioPropId}:`, err);
			continue;
		}

		// Look up the Bedrock property UUID once per property
		const { data: prop } = await supabase
			.from('properties')
			.select('id')
			.eq('workspace_id', workspaceId)
			.eq('appfolio_property_id', String(appfolioPropId))
			.maybeSingle();

		for (const row of rows as any[]) {
			const woId = row.work_order_id;
			if (woId == null) continue;

			// Look up unit by appfolio_unit_id if present
			let unitId: string | null = null;
			let propertyId: string | null = prop?.id ?? null;
			if (row.unit_id != null) {
				const { data: unit } = await supabase
					.from('units')
					.select('id, property_id')
					.eq('appfolio_unit_id', String(row.unit_id))
					.maybeSingle();
				if (unit) {
					unitId = unit.id;
					propertyId = unit.property_id ?? propertyId;
				}
			}

			const description = row.job_description || row.service_request_description || null;
			const name = description
				? description.slice(0, 120)
				: `Work Order ${row.service_request_number ?? woId}`;

			const { error } = await supabase.from('issues').upsert(
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
			);
			if (error) {
				console.error(`syncWorkOrders upsert error for work_order_id=${woId}:`, error.message);
			}
		}
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
				await syncVendors(ws.id);
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
