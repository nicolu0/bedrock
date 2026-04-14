// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const POST = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const issueId = body?.issue_id;
	const draftId = body?.draft_id ?? null;
	const messageId = body?.message_id ?? null;
	if (!issueId) return json({ error: 'Invalid payload' }, { status: 400 });

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('id, workspace_id, name, parent_id')
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

	const draftQuery = supabaseAdmin
		.from('drafts')
		.select(
			'id, issue_id, message_id, subject, body, sender_email, recipient_email, recipient_emails, channel'
		);
	const { data: approvedDraft } = draftId
		? await draftQuery.eq('id', draftId).maybeSingle()
		: messageId
			? await draftQuery.eq('message_id', messageId).eq('channel', 'appfolio').maybeSingle()
			: await draftQuery
					.eq('issue_id', issue.id)
					.is('message_id', null)
					.eq('channel', 'appfolio')
					.maybeSingle();

	const { data: approver } = await supabaseAdmin
		.from('users')
		.select('name')
		.eq('id', locals.user.id)
		.maybeSingle();
	const approvedBy = approver?.name ?? 'Unknown';

	await supabaseAdmin.from('activity_logs').insert({
		workspace_id: issue.workspace_id,
		issue_id: issue.id,
		type: 'appfolio_approved',
		data: {
			approved_by: approvedBy,
			approved_by_id: locals.user.id,
			draft: {
				id: approvedDraft?.id ?? draftId,
				message_id: approvedDraft?.message_id ?? messageId ?? null,
				subject: approvedDraft?.subject ?? null,
				body: approvedDraft?.body ?? null,
				recipient_email: approvedDraft?.recipient_email ?? null,
				recipient_emails: approvedDraft?.recipient_emails ?? null,
				channel: approvedDraft?.channel ?? 'appfolio'
			}
		},
		created_by: locals.user.id
	});

	const issueName = (issue?.name ?? '').toString();
	const isTriage = /^triage\s+/i.test(issueName);
	const isSchedule = /^schedule\s+/i.test(issueName);
	const followupBody = isSchedule
		? 'Have you contacted the tenant to schedule?'
		: isTriage
			? 'Has the vendor gotten in contact with you to schedule?'
			: null;
	let followupDraft = null;

	if (followupBody) {
		const originalMessageId = approvedDraft?.message_id ?? messageId ?? null;
		if (approvedDraft?.id) {
			await supabaseAdmin.from('drafts').delete().eq('id', approvedDraft.id);
		}
		const followupSubject = approvedDraft?.subject ?? issue.name ?? 'Follow up on scheduling';
		const followupPayload = {
			issue_id: issue.id,
			message_id: originalMessageId,
			sender_email: approvedDraft?.sender_email ?? '',
			recipient_email: approvedDraft?.recipient_email ?? null,
			recipient_emails: approvedDraft?.recipient_emails ?? null,
			subject: followupSubject,
			body: followupBody,
			original_body: followupBody,
			draft_diff: null,
			channel: 'appfolio',
			updated_at: new Date().toISOString()
		};
		const { data: createdFollowup, error: followupError } = await supabaseAdmin
			.from('drafts')
			.insert(followupPayload)
			.select(
				'id, issue_id, message_id, sender_email, recipient_email, recipient_emails, subject, body, original_body, draft_diff, updated_at, channel'
			)
			.single();
		if (followupError) {
			return json({ error: followupError.message }, { status: 400 });
		}
		if (createdFollowup?.id) {
			followupDraft = createdFollowup;
		}
	}

	// Approval should only advance the approved *subissue*.
	// Never change root issue status.
	if (issue.parent_id) {
		await supabaseAdmin
			.from('issues')
			.update({ status: 'in_progress', updated_at: new Date().toISOString() })
			.eq('id', issue.id);
	}

	return json({
		ok: true,
		approved_by: approvedBy,
		issue_id: issue.id,
		parent_issue_id: issue.parent_id ?? null,
		followup_draft: followupDraft ?? null
	});
};
