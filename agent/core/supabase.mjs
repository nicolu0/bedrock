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
	'id,workspace_id,appfolio_srn,name,description,urgent,created_at,property_id,vendor_id,' +
	'status,status_reason,status_updated_at,' +
	'tenant:tenants!tenant_id(name),' +
	'property:properties!property_id(name),' +
	'unit:units!unit_id(name),' +
	'vendor:vendors!vendor_id(name)';

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
// (and, transitionally, set_vendor). Callers pass an already-whitelisted patch;
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

// Delete all issues in a workspace plus their agent_runs (FK dep). Used by
// the "Clear test workspace" button — should never be called on prod.
export async function deleteIssuesByWorkspace(workspace_id) {
	if (!workspace_id) throw new Error('deleteIssuesByWorkspace: workspace_id required');
	const { url, key } = supabaseEnv();
	const headers = authHeaders(key);

	// 1. Fetch the issue ids so we can target agent_runs.
	const idsRes = await fetch(
		`${url}/rest/v1/issues_v2?select=id&workspace_id=eq.${workspace_id}`,
		{ headers }
	);
	if (!idsRes.ok) {
		throw new Error(`fetch issues: ${idsRes.status} ${await idsRes.text()}`);
	}
	const rows = await idsRes.json();
	const ids = rows.map((r) => r.id);
	if (ids.length === 0) return { issues_deleted: 0, agent_runs_deleted: 0 };

	// 2. Delete agent_runs first (FK).
	const runsRes = await fetch(
		`${url}/rest/v1/agent_runs?issue_id=in.(${ids.join(',')})`,
		{ method: 'DELETE', headers }
	);
	if (!runsRes.ok) {
		throw new Error(`delete agent_runs: ${runsRes.status} ${await runsRes.text()}`);
	}

	// 3. Delete the issues themselves.
	const issuesRes = await fetch(
		`${url}/rest/v1/issues_v2?workspace_id=eq.${workspace_id}`,
		{ method: 'DELETE', headers }
	);
	if (!issuesRes.ok) {
		throw new Error(`delete issues: ${issuesRes.status} ${await issuesRes.text()}`);
	}

	return { issues_deleted: ids.length };
}
