// @ts-nocheck
import { json } from '@sveltejs/kit';
import { AGENT_WEBHOOK_SECRET } from '$env/static/private';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const getDefaultSenderEmail = async (userId) => {
	if (!userId) return null;
	const { data: sendConnection } = await supabaseAdmin
		.from('gmail_connections')
		.select('email, mode, updated_at')
		.eq('user_id', userId)
		.in('mode', ['write', 'both'])
		.order('updated_at', { ascending: false })
		.limit(1)
		.maybeSingle();
	if (sendConnection?.email) return sendConnection.email;
	const { data: anyConnection } = await supabaseAdmin
		.from('gmail_connections')
		.select('email, updated_at')
		.eq('user_id', userId)
		.order('updated_at', { ascending: false })
		.limit(1)
		.maybeSingle();
	return anyConnection?.email ?? null;
};

const listWorkspaceUnitsForAgent = async (workspaceId) => {
	const { data } = await supabaseAdmin
		.from('units')
		.select('id, name, property_id, properties!inner(name, address, workspace_id)')
		.eq('properties.workspace_id', workspaceId)
		.order('name', { ascending: true });
	return (data ?? []).map((unit) => ({
		id: unit.id,
		name: unit.name,
		property_id: unit.property_id,
		property_name: unit.properties?.name ?? null,
		property_address: unit.properties?.address ?? null
	}));
};

const getPolicyText = async (workspaceId) => {
	if (!workspaceId) return '';
	const { data: policyRow } = await supabaseAdmin
		.from('workspace_policies')
		.select('policy_text')
		.eq('workspace_id', workspaceId)
		.in('type', ['behavior', 'allow'])
		.order('updated_at', { ascending: false })
		.limit(1)
		.maybeSingle();
	return policyRow?.policy_text ?? '';
};

const getThreadContext = async (threadId) => {
	if (!threadId) return { threadIssueId: null, rootIssueId: null, relatedIssues: [] };
	const { data: threadRow } = await supabaseAdmin
		.from('threads')
		.select('issue_id')
		.eq('id', threadId)
		.maybeSingle();
	const threadIssueId = threadRow?.issue_id ?? null;
	let rootIssueId = threadIssueId;
	let relatedIssues = [];
	if (threadIssueId) {
		const { data: issueRow } = await supabaseAdmin
			.from('issues')
			.select('id, name, status, parent_id')
			.eq('id', threadIssueId)
			.maybeSingle();
		rootIssueId = issueRow?.parent_id ?? issueRow?.id ?? threadIssueId;
		if (rootIssueId) {
			const { data: related } = await supabaseAdmin
				.from('issues')
				.select('id, name, status, parent_id')
				.or(`id.eq.${rootIssueId},parent_id.eq.${rootIssueId}`);
			relatedIssues = related ?? [];
		}
	}
	return { threadIssueId, rootIssueId, relatedIssues };
};

const runAgentForPolicy = async ({
	request,
	workspaceId,
	userId,
	senderEmail,
	subject,
	body,
	threadId,
	messageId
}) => {
	if (!AGENT_WEBHOOK_SECRET) return;
	if (!workspaceId || !userId || !senderEmail || !body || !threadId) return;

	const [{ data: userProfile }, defaultSenderEmail, policyText, workspaceUnits, threadContext] =
		await Promise.all([
			supabaseAdmin.from('users').select('name').eq('id', userId).maybeSingle(),
			getDefaultSenderEmail(userId),
			getPolicyText(workspaceId),
			listWorkspaceUnitsForAgent(workspaceId),
			getThreadContext(threadId)
		]);

	const userName = userProfile?.name ?? 'Bedrock';
	const origin = new URL(request.url).origin;
	console.log('policy-agent run', {
		workspace_id: workspaceId,
		user_id: userId,
		thread_id: threadId,
		message_id: messageId
	});
	await fetch(`${origin}/api/agent`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Agent-Secret': AGENT_WEBHOOK_SECRET
		},
		body: JSON.stringify({
			source: 'gmail',
			subject: subject ?? '',
			body,
			sender_email: senderEmail,
			workspace_id: workspaceId,
			thread_id: threadId,
			user_id: userId,
			policy_text: policyText,
			user_name: userName,
			default_sender_email: defaultSenderEmail,
			reply_message_id: messageId ?? null,
			root_issue_id: threadContext.rootIssueId,
			thread_issue_id: threadContext.threadIssueId,
			related_issues: threadContext.relatedIssues,
			workspace_units: workspaceUnits
		})
	});
};

export const POST = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const payload = await request.json().catch(() => null);
	const workspaceId = payload?.workspace_id ?? null;
	const senderEmailRaw = payload?.sender_email ?? '';
	const action = payload?.action ?? '';
	const comment = typeof payload?.comment === 'string' ? payload.comment.trim() : '';
	const notificationId = payload?.notification_id ?? null;

	let resolvedWorkspaceId = workspaceId;
	let notificationMeta = null;
	let notificationBody = '';
	let notificationTitle = '';
	if (!resolvedWorkspaceId && notificationId) {
		const { data: notifRow } = await supabaseAdmin
			.from('notifications')
			.select('workspace_id, user_id, meta, body, title')
			.eq('id', notificationId)
			.maybeSingle();
		if (notifRow?.user_id && notifRow.user_id !== locals.user.id) {
			return json({ error: 'Forbidden' }, { status: 403 });
		}
		resolvedWorkspaceId = notifRow?.workspace_id ?? null;
		notificationMeta = notifRow?.meta ?? null;
		notificationBody = notifRow?.body ?? '';
		notificationTitle = notifRow?.title ?? '';
	}

	if (!resolvedWorkspaceId || !action) {
		return json({ error: 'Missing workspace_id or action' }, { status: 400 });
	}

	const allowedActions = new Set(['allow', 'block', 'ignore']);
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
		.in('role', ['admin', 'bedrock', 'member', 'owner'])
		.maybeSingle();

	if (!membership?.id && !personRow?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	if (action !== 'ignore') {
		const senderEmail = normalizeEmail(senderEmailRaw);
		if (!senderEmail) {
			return json({ error: 'Missing sender_email' }, { status: 400 });
		}

		await supabaseAdmin.from('workspace_policies').insert({
			workspace_id: resolvedWorkspaceId,
			type: action,
			email: senderEmail,
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

	if (action === 'allow') {
		const meta = notificationMeta ?? {};
		const senderEmail = normalizeEmail(meta?.sender_email ?? senderEmailRaw);
		const subject = typeof meta?.subject === 'string' ? meta.subject : notificationTitle;
		const body = typeof meta?.body === 'string' ? meta.body : notificationBody;
		const threadId = typeof meta?.thread_id === 'string' ? meta.thread_id : null;
		const messageId = typeof meta?.message_id === 'string' ? meta.message_id : null;
		await runAgentForPolicy({
			request,
			workspaceId: resolvedWorkspaceId,
			userId: locals.user.id,
			senderEmail,
			subject,
			body,
			threadId,
			messageId
		});
	}

	return json({ success: true });
};
