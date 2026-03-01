// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

const ACTIVITY_WINDOW_DAYS = 30;

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data: issues } = await supabaseAdmin
		.from('issues')
		.select('id')
		.eq('workspace_id', workspace.id);

	const issueIds = (issues ?? []).map((issue) => issue.id).filter(Boolean);
	if (!issueIds.length) {
		return json({ messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] });
	}

	const cutoff = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const [messagesResult, draftsResult] = await Promise.all([
		supabaseAdmin
			.from('messages')
			.select('id, issue_id, message, sender, subject, timestamp, direction, channel')
			.in('issue_id', issueIds)
			.gte('timestamp', cutoff)
			.order('timestamp', { ascending: true }),
		supabaseAdmin
			.from('email_drafts')
			.select('id, issue_id, message_id, sender, recipient, subject, body, updated_at')
			.in('issue_id', issueIds)
			.gte('updated_at', cutoff)
			.order('updated_at', { ascending: false })
	]);

	const messagesByIssue = (messagesResult?.data ?? []).reduce((acc, message) => {
		if (!message.issue_id) return acc;
		if (!acc[message.issue_id]) acc[message.issue_id] = [];
		acc[message.issue_id].push(message);
		return acc;
	}, {});

	const emailDraftsByMessageId = (draftsResult?.data ?? []).reduce((acc, draft) => {
		if (!draft.message_id || acc[draft.message_id]) return acc;
		acc[draft.message_id] = draft;
		return acc;
	}, {});

	const draftIssueIds = [
		...new Set((draftsResult?.data ?? []).map((draft) => draft.issue_id).filter(Boolean))
	];

	return json({ messagesByIssue, emailDraftsByMessageId, draftIssueIds });
};
