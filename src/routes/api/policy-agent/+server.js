// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export const POST = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const payload = await request.json().catch(() => null);
	const workspaceId = payload?.workspace_id ?? null;
	const senderEmailRaw = payload?.sender_email ?? '';
	const action = payload?.action ?? '';
	const comment = typeof payload?.comment === 'string' ? payload.comment.trim() : '';
	const notificationId = payload?.notification_id ?? null;

	let resolvedWorkspaceId = workspaceId;
	if (!resolvedWorkspaceId && notificationId) {
		const { data: notifRow } = await supabaseAdmin
			.from('notifications')
			.select('workspace_id, user_id')
			.eq('id', notificationId)
			.maybeSingle();
		if (notifRow?.user_id && notifRow.user_id !== locals.user.id) {
			return json({ error: 'Forbidden' }, { status: 403 });
		}
		resolvedWorkspaceId = notifRow?.workspace_id ?? null;
	}

	if (!resolvedWorkspaceId || !action) {
		return json({ error: 'Missing workspace_id or action' }, { status: 400 });
	}

	const allowedActions = new Set(['allow', 'block', 'behavior', 'ignore']);
	if (!allowedActions.has(action)) {
		return json({ error: 'Invalid action' }, { status: 400 });
	}

	const { data: membership } = await supabaseAdmin
		.from('members')
		.select('id')
		.eq('workspace_id', resolvedWorkspaceId)
		.eq('user_id', locals.user.id)
		.maybeSingle();

	const { data: personRow } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('workspace_id', resolvedWorkspaceId)
		.eq('user_id', locals.user.id)
		.in('role', ['admin', 'member', 'owner'])
		.maybeSingle();

	if (!membership?.id && !personRow?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	if (action !== 'ignore') {
		const senderEmail = normalizeEmail(senderEmailRaw);
		if ((action === 'allow' || action === 'block') && !senderEmail) {
			return json({ error: 'Missing sender_email' }, { status: 400 });
		}

		await supabaseAdmin.from('workspace_policies').insert({
			workspace_id: resolvedWorkspaceId,
			type: action,
			email: action === 'behavior' ? null : senderEmail,
			description: comment || null,
			created_by: locals.user.id,
			meta: {
				source: 'inbox',
				sender_email: senderEmail || normalizeEmail(senderEmailRaw) || null,
				comment: comment || null,
				notification_id: notificationId || null
			}
		});
	}

	if (notificationId) {
		await supabaseAdmin
			.from('notifications')
			.update({ is_read: true, is_resolved: true, requires_action: false })
			.eq('id', notificationId);
	}

	return json({ success: true });
};
