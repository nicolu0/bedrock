// Shared Supabase helpers. Imported by issue-poller (work-order list) and by
// the F2 draft tools (per-issue lookup). All reads go through the REST API
// with the service-role key.

export function supabaseEnv() {
	const url = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) {
		throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
	}
	return { url, key };
}

function authHeaders(key) {
	return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };
}

// The standard select string used everywhere we read an issue with joins.
// One place to add fields when we need more.
const ISSUE_SELECT =
	'id,workspace_id,appfolio_srn,name,description,urgent,created_at,property_id,vendor_id,unit_id,' +
	'status,status_reason,status_updated_at,' +
	'tenant:tenants!tenant_id(name,phone),' +
	'property:properties!property_id(name),' +
	'unit:units!unit_id(name),' +
	'vendor:vendors!vendor_id(name,phone)';

// Format a stored phone (digits-only, as crawled) for display in a draft body.
// All rows are 10-digit US numbers; tolerate a leading country `1` and fall
// back to the raw digits if the length is unexpected. Returns null for empty.
export function formatPhone(raw) {
	if (!raw) return null;
	const digits = String(raw).replace(/\D/g, '');
	const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
	if (ten.length !== 10) return digits || null;
	return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// Look up a single vendor row by name within a workspace. Used by draft_tenant
// when the PM names an override vendor (one not on the issue row) so we can put
// THAT vendor's phone in the tenant message. Tries an exact case-insensitive
// match first, then a substring match (PM types "Luigi" → "Luigi's Plumbing").
// Returns { id, name, phone } or null.
export async function fetchVendorByName(workspace_id, name) {
	if (!workspace_id || !name?.trim()) return null;
	const { url, key } = supabaseEnv();
	const esc = (s) => s.replace(/[%,()*]/g, ' ').trim();
	const clean = esc(name);
	for (const pattern of [`ilike.${clean}`, `ilike.*${clean}*`]) {
		const params = new URLSearchParams({
			select: 'id,name,phone',
			workspace_id: `eq.${workspace_id}`,
			name: pattern,
			limit: '1'
		});
		const res = await fetch(`${url}/rest/v1/vendors?${params}`, { headers: authHeaders(key) });
		if (!res.ok) throw new Error(`fetchVendorByName ${res.status}: ${await res.text()}`);
		const rows = await res.json();
		if (rows[0]) return rows[0];
	}
	return null;
}

// Find a reachable phone for a unit when the issue's own tenant has none.
// Many phoneless tenants are co-tenants (kids/spouse/roommates) on a lease
// whose primary leaseholder DOES have a number on file — so for a vendor to
// reach "the unit" we fall back to any unit-mate with a phone. `excludeName`
// skips the tenant already tried. Returns raw digits, or null.
export async function fetchUnitTenantPhone(unit_id, { excludeName } = {}) {
	if (!unit_id) return null;
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'name,phone',
		unit_id: `eq.${unit_id}`,
		phone: 'not.is.null',
		order: 'name.asc'
	});
	const res = await fetch(`${url}/rest/v1/tenants?${params}`, { headers: authHeaders(key) });
	if (!res.ok) throw new Error(`fetchUnitTenantPhone ${res.status}: ${await res.text()}`);
	const rows = await res.json();
	const exclude = (excludeName ?? '').trim().toLowerCase();
	const hit = rows.find(
		(r) => r.phone && r.phone.trim() && r.name?.trim().toLowerCase() !== exclude
	);
	return hit?.phone ?? null;
}

export async function fetchIssueById(id) {
	if (!id) throw new Error('fetchIssueById: id required');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: ISSUE_SELECT,
		id: `eq.${id}`,
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/issues_v2?${params}`, { headers: authHeaders(key) });
	if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
	const rows = await res.json();
	return rows[0] ?? null;
}

// Patch a single issues_v2 row and return the updated representation. The
// agent's one write path into the work-order record — used by update_issue
// and by the awaiting_pm status flip when a WO summary is sent. Callers pass an
// already-whitelisted patch;
// the DB's issues_v2_status_check rejects any out-of-enum status. Throws on
// HTTP error; returns null if no row matched the id.
export async function patchIssue(id, patch) {
	if (!id) throw new Error('patchIssue: id required');
	const { url, key } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/issues_v2?id=eq.${encodeURIComponent(id)}`, {
		method: 'PATCH',
		headers: {
			...authHeaders(key),
			'Content-Type': 'application/json',
			Prefer: 'return=representation'
		},
		body: JSON.stringify(patch)
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`patchIssue ${res.status}: ${detail.slice(0, 200)}`);
	}
	const rows = await res.json();
	return rows[0] ?? null;
}
