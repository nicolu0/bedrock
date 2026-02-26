import { supabaseAdmin } from '$lib/supabaseAdmin';

/**
 * Creates one notification row per workspace member.
 * @param {string} workspaceId
 * @param {string} issueId
 * @param {string} title  - e.g. "[MAP 1] Clogged toilet"
 * @param {string} body   - e.g. "Agent dispatched Acme Plumbing for Unit 701..."
 */
export async function notifyWorkspace(workspaceId, issueId, title, body) {
	const { data: members } = await supabaseAdmin
		.from('members')
		.select('user_id')
		.eq('workspace_id', workspaceId);

	if (!members?.length) return;

	const rows = members.map(({ user_id }) => ({
		workspace_id: workspaceId,
		issue_id: issueId,
		user_id,
		title,
		body
	}));

	await supabaseAdmin.from('notifications').insert(rows);
}

/**
 * Creates a notification for a single user.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} issueId
 * @param {string} title
 * @param {string} body
 */
export async function notifyUser(userId, workspaceId, issueId, title, body) {
	await supabaseAdmin.from('notifications').insert({
		user_id: userId,
		workspace_id: workspaceId,
		issue_id: issueId,
		title,
		body,
		type: 'info',
	});
}
