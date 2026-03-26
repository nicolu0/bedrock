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
		.from('people')
		.select('user_id')
		.eq('workspace_id', workspaceId)
		.in('role', ['admin', 'member', 'owner'])
		.not('user_id', 'is', null);

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
 * Notify all bedrock-role members in the LAPM workspace that an AppFolio action
 * requires manual execution. Called server-side after a PM approves an action
 * on an AppFolio-sourced issue. Non-blocking — never throws.
 *
 * @param {object} opts
 * @param {object} opts.issue        - Issue object with id, name, appfolio_id, readable_id
 * @param {string} opts.action       - 'email_send' | 'vendor_assign' | 'status_change'
 * @param {string} opts.title        - Notification title shown to founders
 * @param {string} opts.body         - Notification body with action details
 * @param {object} [opts.meta]       - Additional context (vendor name, email body excerpt, etc.)
 */
export async function notifyFoundersOfAppfolioAction({ issue, action, title, body, meta = {} }) {
	const { data: lapmWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('id')
		.eq('slug', 'lapm')
		.maybeSingle();

	if (!lapmWorkspace?.id) return;

	const { data: founders } = await supabaseAdmin
		.from('people')
		.select('user_id')
		.eq('workspace_id', lapmWorkspace.id)
		.eq('role', 'bedrock');

	if (!founders?.length) return;

	await supabaseAdmin.from('notifications').insert(
		founders.map((f) => ({
			workspace_id: lapmWorkspace.id,
			user_id: f.user_id,
			issue_id: issue.id ?? null,
			title,
			body,
			type: 'appfolio_action_required',
			requires_action: true,
			is_resolved: false,
			meta: {
				action,
				appfolio_id: issue.appfolio_id ?? null,
				readable_id: issue.readable_id ?? null,
				issue_name: issue.name ?? null,
				...meta
			}
		}))
	);
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
		type: 'info'
	});
}
