// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, depends }) => {
	depends('app:coordinator');
	const { workspace } = await parent();

	const { data: workspaceRow } = await supabaseAdmin
		.from('workspaces')
		.select('id, coordinator_thread_id, coordinator_label, coordinator_chat_guid')
		.eq('id', workspace.id)
		.maybeSingle();

	const threadId = workspaceRow?.coordinator_thread_id ?? null;

	let messages = [];
	if (threadId) {
		const { data } = await supabaseAdmin
			.from('messages')
			.select('id, issue_id, message, sender, direction, timestamp, channel, metadata')
			.eq('workspace_id', workspace.id)
			.eq('thread_id', threadId)
			.order('timestamp', { ascending: true })
			.limit(500);
		messages = data ?? [];
	}

	const linkedIssueIds = Array.from(new Set(messages.map((m) => m.issue_id).filter(Boolean)));
	let issuesById = {};
	if (linkedIssueIds.length) {
		const { data: issues } = await supabaseAdmin
			.from('issues')
			.select('id, name, service_request_number, readable_id')
			.in('id', linkedIssueIds);
		issuesById = Object.fromEntries((issues ?? []).map((i) => [i.id, i]));
	}

	const { data: openIssues } = await supabaseAdmin
		.from('issues')
		.select('id, name, service_request_number, readable_id, status')
		.eq('workspace_id', workspace.id)
		.neq('status', 'done')
		.order('updated_at', { ascending: false })
		.limit(200);

	return {
		coordinator: {
			threadId,
			label: workspaceRow?.coordinator_label ?? 'Coordinator',
			chatGuid: workspaceRow?.coordinator_chat_guid ?? null,
			messages,
			issuesById,
			openIssues: openIssues ?? []
		}
	};
};
