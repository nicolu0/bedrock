// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ url, locals }) => {
	const token = url.searchParams.get('token');
	if (!token) throw redirect(303, '/');
	let inviteEmail = null;
	let inviteMeta = null;
	let workspaceSlug = null;
	const { data: invite } = await supabaseAdmin
		.from('invites')
		.select('email, accepted_at, expires_at, role, workspace_id, invited_by')
		.eq('token', token)
		.maybeSingle();

	const inviteExpiresAt = invite?.expires_at ? new Date(invite.expires_at) : null;
	const isValidInvite =
		invite && !invite.accepted_at && (!inviteExpiresAt || inviteExpiresAt > new Date());

	if (isValidInvite) {
		inviteEmail = invite.email ?? null;

		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('name, slug')
			.eq('id', invite.workspace_id)
			.maybeSingle();
		workspaceSlug = workspace?.slug ?? null;

		let inviterName = null;
		if (invite.invited_by) {
			const { data: inviterPerson } = await supabaseAdmin
				.from('people')
				.select('name')
				.eq('workspace_id', invite.workspace_id)
				.eq('user_id', invite.invited_by)
				.maybeSingle();
			inviterName = inviterPerson?.name ?? null;

			if (!inviterName) {
				const { data: inviterUser } = await supabaseAdmin
					.from('users')
					.select('name')
					.eq('id', invite.invited_by)
					.maybeSingle();
				inviterName = inviterUser?.name ?? null;
			}
		}

		inviteMeta = {
			inviterName,
			workspaceName: workspace?.name ?? null,
			role: invite.role ?? null
		};
	}

	return {
		token,
		user: locals.user,
		inviteEmail,
		inviteMeta,
		inviteValid: !!isValidInvite,
		workspaceSlug
	};
};
