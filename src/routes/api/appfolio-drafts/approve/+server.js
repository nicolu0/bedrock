// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const pickLowestLoadAssignee = (candidates, issues) => {
	const counts = new Map();
	for (const candidate of candidates) {
		counts.set(candidate.user_id, 0);
	}
	for (const issue of issues ?? []) {
		if (!issue?.assignee_id || !counts.has(issue.assignee_id)) continue;
		counts.set(issue.assignee_id, counts.get(issue.assignee_id) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => {
			if (a[1] !== b[1]) return a[1] - b[1];
			return String(a[0]).localeCompare(String(b[0]));
		})
		.map(([userId]) => userId)[0];
};

export const POST = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const issueId = body?.issue_id;
	if (!issueId) return json({ error: 'Invalid payload' }, { status: 400 });

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('id, workspace_id, name')
		.eq('id', issueId)
		.maybeSingle();
	if (!issue?.id || !issue.workspace_id) {
		return json({ error: 'Issue not found' }, { status: 404 });
	}

	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('workspace_id', issue.workspace_id)
		.eq('user_id', locals.user.id)
		.in('role', ['admin', 'member', 'owner', 'bedrock'])
		.maybeSingle();

	if (!member?.id) {
		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('id', issue.workspace_id)
			.eq('admin_user_id', locals.user.id)
			.maybeSingle();
		if (!workspace?.id) {
			return json({ error: 'Forbidden' }, { status: 403 });
		}
	}

	const { data: bedrockPeople } = await supabaseAdmin
		.from('people')
		.select('user_id, users(name)')
		.eq('workspace_id', issue.workspace_id)
		.eq('role', 'bedrock')
		.not('user_id', 'is', null);

	const candidates = (bedrockPeople ?? []).filter((row) => row?.user_id);
	if (!candidates.length) {
		return json({ error: 'No bedrock assignees found' }, { status: 400 });
	}

	const candidateIds = candidates.map((row) => row.user_id);
	const { data: openIssues } = await supabaseAdmin
		.from('issues')
		.select('id, assignee_id, status')
		.eq('workspace_id', issue.workspace_id)
		.neq('status', 'done')
		.in('assignee_id', candidateIds);

	const assigneeId = pickLowestLoadAssignee(candidates, openIssues ?? []);
	if (!assigneeId) {
		return json({ error: 'Unable to select assignee' }, { status: 400 });
	}

	await supabaseAdmin
		.from('issues')
		.update({ assignee_id: assigneeId, updated_at: new Date().toISOString() })
		.eq('id', issue.id);

	const { data: approver } = await supabaseAdmin
		.from('users')
		.select('name')
		.eq('id', locals.user.id)
		.maybeSingle();
	const approvedBy = approver?.name ?? 'Unknown';
	const assigneeName = candidates.find((row) => row.user_id === assigneeId)?.users?.name ?? null;

	await supabaseAdmin.from('activity_logs').insert({
		workspace_id: issue.workspace_id,
		issue_id: issue.id,
		type: 'appfolio_approved',
		data: {
			approved_by: approvedBy,
			approved_by_id: locals.user.id,
			assignee_id: assigneeId,
			assignee_name: assigneeName
		},
		created_by: locals.user.id
	});

	// Notify all bedrock users that a draft was approved and needs action
	// (reuses bedrockPeople already fetched above)
	if (bedrockPeople?.length) {
		await supabaseAdmin.from('notifications').insert(
			bedrockPeople.map((p) => ({
				workspace_id: issue.workspace_id,
				issue_id: issue.id,
				user_id: p.user_id,
				title: 'Draft Approved',
				body: `${approvedBy} approved a draft — ${issue.name}`,
				type: 'draft_approved',
				requires_action: true
			}))
		);
	}

	return json({
		ok: true,
		approved_by: approvedBy,
		assignee_id: assigneeId,
		assignee_name: assigneeName
	});
};
