// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

export const POST = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const {
		workspace: workspaceSlug,
		name,
		description,
		unitId,
		propertyId,
		status,
		assigneeId
	} = body;

	if (!name?.trim()) return json({ error: 'Issue title is required.' }, { status: 400 });

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) return json({ error: 'Workspace access denied.' }, { status: 403 });

	let resolvedUnitId = null;
	let resolvedPropertyId = null;
	if (typeof propertyId === 'string' && propertyId.trim()) {
		const { data: propertyRow } = await supabaseAdmin
			.from('properties')
			.select('id')
			.eq('id', propertyId.trim())
			.eq('workspace_id', workspace.id)
			.maybeSingle();
		if (!propertyRow?.id) return json({ error: 'Property not found.' }, { status: 400 });
		resolvedPropertyId = propertyRow.id;
	}
	if (typeof unitId === 'string' && unitId.trim()) {
		const { data: unitRow } = await supabaseAdmin
			.from('units')
			.select('id, property_id, properties!inner(id, workspace_id)')
			.eq('id', unitId.trim())
			.eq('properties.workspace_id', workspace.id)
			.maybeSingle();
		if (!unitRow?.id) return json({ error: 'Unit not found.' }, { status: 400 });
		resolvedUnitId = unitRow.id;
		if (resolvedPropertyId && unitRow.property_id && resolvedPropertyId !== unitRow.property_id) {
			return json({ error: 'Unit does not belong to selected property.' }, { status: 400 });
		}
		if (!resolvedPropertyId && unitRow.property_id) {
			resolvedPropertyId = unitRow.property_id;
		}
	}

	const allowedStatuses = new Set(['todo', 'in_progress', 'done']);
	const normalizedStatus = allowedStatuses.has(status) ? status : 'todo';

	let resolvedAssigneeId = null;
	if (typeof assigneeId === 'string' && assigneeId.trim()) {
		const { data: memberRow } = await supabaseAdmin
			.from('people')
			.select('user_id')
			.eq('workspace_id', workspace.id)
			.eq('user_id', assigneeId.trim())
			.maybeSingle();
		if (!memberRow?.user_id) return json({ error: 'Assignee not found.' }, { status: 400 });
		resolvedAssigneeId = memberRow.user_id;
	}

	const { data, error } = await supabaseAdmin
		.from('issues')
		.insert({
			workspace_id: workspace.id,
			name: name.trim(),
			description: description?.trim() ? description.trim() : null,
			unit_id: resolvedUnitId,
			property_id: resolvedPropertyId,
			status: normalizedStatus,
			assignee_id: resolvedAssigneeId
		})
		.select(
			'id, name, status, issue_number, readable_id, assignee_id, parent_id, unit_id, property_id'
		)
		.single();

	if (error) return json({ error: error.message }, { status: 500 });
	return json(data);
};
