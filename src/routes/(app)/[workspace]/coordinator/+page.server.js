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
			.select('id, message, sender, direction, timestamp, channel, metadata')
			.eq('workspace_id', workspace.id)
			.eq('thread_id', threadId)
			.order('timestamp', { ascending: true })
			.limit(500);
		messages = data ?? [];
	}

	return {
		coordinator: {
			threadId,
			label: workspaceRow?.coordinator_label ?? 'Coordinator',
			chatGuid: workspaceRow?.coordinator_chat_guid ?? null,
			messages
		}
	};
};
