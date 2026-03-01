// @ts-nocheck
import { redirect, error } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const statusOrder = ['in_progress', 'todo', 'done'];
const allowedStatuses = new Set(statusOrder);

const slugify = (value) =>
	(value ?? '')
		.toString()
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

export const load = async ({ locals, params, parent }) => {
	if (!locals.user) {
		throw redirect(303, '/');
	}

	const issueId = params.issue_id;
	const userId = locals.user.id;

	const parentData = await parent();
	const workspaceId = parentData?.workspace?.id ?? null;

	if (!workspaceId) {
		return {
			issue: null,
			subIssues: [],
			assignee: null,
			messagesByIssue: {},
			emailDraftsByMessageId: {},
			draftIssueIds: [],
			userId,
			issueDetail: Promise.resolve(null)
		};
	}

	// Fast initial fetch for canonical validation + immediate page data
	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('id, name, status')
		.eq('id', issueId)
		.eq('workspace_id', workspaceId)
		.maybeSingle();

	if (!issue) {
		throw error(404, 'Issue not found.');
	}

	const normalizedIssue = {
		...issue,
		description: issue?.description ?? null,
		status: allowedStatuses.has(issue.status) ? issue.status : 'todo'
	};

	if (normalizedIssue?.name) {
		const expectedSlug = slugify(normalizedIssue.name);
		const currentSlug = params.issue_name ?? '';
		if (expectedSlug && currentSlug !== expectedSlug) {
			throw redirect(303, `/${params.workspace}/issue/${normalizedIssue.id}/${expectedSlug}`);
		}
	}

	const { data: subIssues } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, parent_id')
		.eq('parent_id', issueId)
		.eq('workspace_id', workspaceId)
		.order('updated_at', { ascending: false });

	const normalizedSubIssues = (subIssues ?? []).map((subIssue) => ({
		...subIssue,
		status: allowedStatuses.has(subIssue.status) ? subIssue.status : 'todo'
	}));

	const issueIds = [issueId, ...normalizedSubIssues.map((item) => item.id)];

	let messagesByIssue = {};
	if (issueIds.length) {
		const { data: messages } = await supabaseAdmin
			.from('messages')
			.select('id, issue_id, message, sender, subject, timestamp, direction, channel')
			.in('issue_id', issueIds)
			.order('timestamp', { ascending: true });

		messagesByIssue = (messages ?? []).reduce((acc, message) => {
			if (!message.issue_id) return acc;
			if (!acc[message.issue_id]) acc[message.issue_id] = [];
			acc[message.issue_id].push(message);
			return acc;
		}, {});
	}

	let emailDraftsByMessageId = {};
	let draftIssueIds = [];
	if (issueIds.length) {
		const { data: emailDrafts } = await supabaseAdmin
			.from('email_drafts')
			.select('id, issue_id, message_id, sender, recipient, subject, body, updated_at')
			.in('issue_id', issueIds)
			.order('updated_at', { ascending: false });

		emailDraftsByMessageId = (emailDrafts ?? []).reduce((acc, draft) => {
			if (!draft.message_id || acc[draft.message_id]) return acc;
			acc[draft.message_id] = draft;
			return acc;
		}, {});

		draftIssueIds = [
			...new Set((emailDrafts ?? []).map((draft) => draft.issue_id).filter(Boolean))
		];
	}

	const { data: assignee } = await supabaseAdmin
		.from('users')
		.select('id, name')
		.eq('id', userId)
		.maybeSingle();

	// Streamed detail fetch for client-side seeding/cache priming
	const issueDetail = (async () => {
		const [{ data: fullIssue }, { data: fullSubIssues }, { data: fullAssignee }] =
			await Promise.all([
				supabaseAdmin
					.from('issues')
					.select('id, name, status')
					.eq('id', issueId)
					.eq('workspace_id', workspaceId)
					.maybeSingle(),
				supabaseAdmin
					.from('issues')
					.select('id, name, status, parent_id')
					.eq('parent_id', issueId)
					.eq('workspace_id', workspaceId)
					.order('updated_at', { ascending: false }),
				supabaseAdmin.from('users').select('id, name').eq('id', userId).maybeSingle()
			]);

		const normalizedFullIssue = fullIssue
			? {
					...fullIssue,
					description: fullIssue?.description ?? null,
					status: allowedStatuses.has(fullIssue.status) ? fullIssue.status : 'todo'
				}
			: null;

		const normalizedFullSubIssues = (fullSubIssues ?? []).map((subIssue) => ({
			...subIssue,
			status: allowedStatuses.has(subIssue.status) ? subIssue.status : 'todo'
		}));

		return {
			issue: normalizedFullIssue,
			subIssues: normalizedFullSubIssues,
			assignee: fullAssignee
		};
	})();

	return {
		issue: normalizedIssue,
		subIssues: normalizedSubIssues,
		assignee,
		messagesByIssue,
		emailDraftsByMessageId,
		draftIssueIds,
		userId,
		issueDetail
	};
};
