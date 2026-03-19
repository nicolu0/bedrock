// @ts-nocheck
import { json } from '@sveltejs/kit';
import { AGENT_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY } from '$env/static/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const openaiModel = 'gpt-5-mini-2025-08-07';
const agentSecretHeader = 'x-agent-secret';

const isUuid = (value) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const extractEmail = (fromValue) => {
	const match = fromValue.match(/<([^>]+)>/);
	if (match?.[1]) return match[1].trim();
	return fromValue.trim();
};

const normalizeEmail = (value) => value.trim().toLowerCase();

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

const listVendors = async (workspaceId) => {
	const { data } = await supabaseAdmin
		.from('people')
		.select('id, name, email, trade')
		.eq('workspace_id', workspaceId)
		.eq('role', 'vendor')
		.order('name', { ascending: true });
	return data ?? [];
};

const listWorkspaceAssignees = async (workspaceId) => {
	const { data: people } = await supabaseAdmin
		.from('people')
		.select('user_id, role')
		.eq('workspace_id', workspaceId)
		.in('role', ['admin', 'member', 'owner']);
	const memberIds = (people ?? []).map((row) => row.user_id).filter((id) => typeof id === 'string');
	if (!memberIds.length) return [];

	const { data: users } = await supabaseAdmin.from('users').select('id, name').in('id', memberIds);
	return (users ?? []).map((user) => ({
		id: typeof user.id === 'string' ? user.id : String(user.id ?? ''),
		name: typeof user.name === 'string' ? user.name : null
	}));
};

const getWorkspaceAdminId = async (workspaceId) => {
	const { data } = await supabaseAdmin
		.from('workspaces')
		.select('admin_user_id')
		.eq('id', workspaceId)
		.maybeSingle();
	return data?.admin_user_id ?? null;
};

const getUserNameById = async (userId) => {
	if (!userId) return null;
	const { data } = await supabaseAdmin.from('users').select('name').eq('id', userId).maybeSingle();
	return data?.name ?? null;
};

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

const resolveAssigneeId = ({ requestedAssigneeId, fallbackAssigneeId, eligibleAssignees }) => {
	if (requestedAssigneeId && isUuid(requestedAssigneeId)) {
		if (eligibleAssignees.has(requestedAssigneeId)) {
			return requestedAssigneeId;
		}
	}
	if (fallbackAssigneeId && isUuid(fallbackAssigneeId)) {
		return fallbackAssigneeId;
	}
	return null;
};

const createIssue = async ({ name, unitId, workspaceId, assigneeId, description }) => {
	const { data, error } = await supabaseAdmin
		.from('issues')
		.insert({
			name,
			unit_id: unitId ?? null,
			workspace_id: workspaceId,
			status: 'todo',
			assignee_id: assigneeId ?? null,
			description: description ?? null
		})
		.select('id')
		.single();
	if (error || !data?.id) {
		throw new Error(error?.message ?? 'Issue insert failed');
	}
	return data.id;
};

const createSubissue = async ({
	parentIssueId,
	name,
	unitId,
	workspaceId,
	status,
	reasoning,
	assigneeId,
	description
}) => {
	const { data, error } = await supabaseAdmin
		.from('issues')
		.insert({
			parent_id: parentIssueId,
			name,
			unit_id: unitId ?? null,
			workspace_id: workspaceId,
			status,
			reasoning,
			assignee_id: assigneeId ?? null,
			description: description ?? null
		})
		.select('id')
		.single();
	if (error || !data?.id) {
		throw new Error(error?.message ?? 'Subissue insert failed');
	}
	return data.id;
};

const upsertEmailDraft = async ({
	issueId,
	messageId,
	senderEmail,
	recipientEmail,
	recipientEmails,
	subject,
	body
}) => {
	const normalizedMessageId = messageId && isUuid(messageId) ? messageId : null;
	const normalizedRecipients = Array.isArray(recipientEmails)
		? recipientEmails.map((email) => String(email ?? '').trim()).filter(Boolean)
		: [];
	const fallbackRecipient = typeof recipientEmail === 'string' ? recipientEmail.trim() : '';
	if (!normalizedRecipients.length && fallbackRecipient) {
		normalizedRecipients.push(fallbackRecipient);
	}
	const payload = {
		issue_id: issueId,
		message_id: normalizedMessageId,
		sender_email: senderEmail ?? null,
		recipient_email: normalizedRecipients[0] ?? recipientEmail ?? null,
		recipient_emails: normalizedRecipients.length ? normalizedRecipients : null,
		subject,
		body,
		updated_at: new Date().toISOString()
	};

	let draftId = null;
	let error = null;
	if (normalizedMessageId) {
		const { data: existingDraft } = await supabaseAdmin
			.from('email_drafts')
			.select('id')
			.eq('message_id', normalizedMessageId)
			.maybeSingle();
		if (existingDraft?.id) {
			const result = await supabaseAdmin
				.from('email_drafts')
				.update(payload)
				.eq('id', existingDraft.id);
			draftId = existingDraft.id;
			error = result.error;
		} else {
			const result = await supabaseAdmin.from('email_drafts').insert(payload).select('id').single();
			draftId = result.data?.id ?? null;
			error = result.error;
		}
	} else {
		const { data: existingDraft } = await supabaseAdmin
			.from('email_drafts')
			.select('id')
			.eq('issue_id', issueId)
			.is('message_id', null)
			.maybeSingle();
		if (existingDraft?.id) {
			const result = await supabaseAdmin
				.from('email_drafts')
				.update(payload)
				.eq('id', existingDraft.id);
			draftId = existingDraft.id;
			error = result.error;
		} else {
			const result = await supabaseAdmin.from('email_drafts').insert(payload).select('id').single();
			draftId = result.data?.id ?? null;
			error = result.error;
		}
	}

	if (error || !draftId) {
		throw new Error(error?.message ?? 'Draft insert failed');
	}
	return draftId;
};

const logAgentError = async ({ workspaceId, issueId, userId, action, error, meta }) => {
	if (!workspaceId || !userId) return;
	const { error: insertError } = await supabaseAdmin.from('activity_logs').insert({
		workspace_id: workspaceId,
		issue_id: issueId ?? null,
		type: 'agent-error',
		data: {
			action,
			error,
			...(meta ?? {})
		},
		created_by: userId
	});
	if (insertError) {
		console.error('agent-error log insert failed', insertError);
	}
};

const linkThreadToIssue = async ({ threadId, issueId }) => {
	const { data, error } = await supabaseAdmin
		.from('threads')
		.update({ issue_id: issueId, updated_at: new Date().toISOString() })
		.eq('id', threadId)
		.select('issue_id, workspace_id')
		.maybeSingle();
	if (error) {
		throw new Error(error.message);
	}
	await supabaseAdmin
		.from('messages')
		.update({ issue_id: issueId, workspace_id: data?.workspace_id ?? null })
		.eq('thread_id', threadId);
	return Boolean(data?.issue_id);
};

const updateIssue = async ({ issueId, patch }) => {
	const { data, error } = await supabaseAdmin
		.from('issues')
		.update({ ...patch, updated_at: new Date().toISOString() })
		.eq('id', issueId)
		.select('id')
		.maybeSingle();
	if (error || !data?.id) {
		throw new Error(error?.message ?? 'Issue update failed');
	}
};

const deleteIssue = async ({ issueId }) => {
	const { data: issueRow } = await supabaseAdmin
		.from('issues')
		.select('id, parent_id')
		.eq('id', issueId)
		.maybeSingle();
	if (!issueRow?.id) {
		throw new Error('Issue not found');
	}
	if (!issueRow.parent_id) {
		throw new Error('Refusing to delete root issue');
	}
	const { error } = await supabaseAdmin.from('issues').delete().eq('id', issueId);
	if (error) {
		throw new Error(error.message);
	}
};

const runIssueAgentFromComment = async ({
	issue,
	comment,
	relatedIssues,
	messages,
	policyText,
	workspaceUnits,
	vendors,
	assignees,
	adminUserId,
	userName,
	defaultSenderEmail,
	userId
}) => {
	const system = `You are Bedrock, an assistant for property management.
You are responding to a manager comment tagged @Bedrock on an issue. Apply the requested change using tools.

Guidance:
- You may update the issue or create subissues if requested.
- If the comment implies a new policy ("always do X"), write the update now; policy creation is handled separately.
- If the issue does not map to a unit and you can infer a likely unit from the comment or message context, set unit_id.
- If you cannot infer a unit, you may leave unit_id null.
- If the comment asks to draft an email, you must use draft_email or draft_reply. Do not paste email drafts into descriptions.
- Assignees must be chosen only from eligible assignees; if unsure, use admin_user_id.

 Rules:
 - Use tools only.
 - Be precise and minimal.
 - If drafting to multiple recipients, use recipient_emails with plain email addresses.
 - When done, call done().
 `.trim();

	const createIssueTool = {
		type: 'function',
		name: 'create_issue',
		description: 'Create a new issue',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				title: { type: 'string' },
				unit_id: { type: ['string', 'null'] },
				workspace_id: { type: 'string' },
				assignee_id: { type: 'string' },
				description: { type: 'string' }
			},
			required: ['title', 'workspace_id', 'description']
		}
	};

	const linkThreadTool = {
		type: 'function',
		name: 'link_thread_to_issue',
		description: 'Attach a thread to an issue',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				thread_id: { type: 'string' },
				issue_id: { type: 'string' }
			},
			required: ['thread_id', 'issue_id']
		}
	};

	const updateIssueTool = {
		type: 'function',
		name: 'update_issue',
		description: 'Update the current issue fields',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				issue_id: { type: 'string' },
				name: { type: 'string' },
				status: { type: 'string' },
				assignee_id: { type: 'string' },
				description: { type: 'string' },
				unit_id: { type: ['string', 'null'] }
			},
			required: []
		}
	};

	const createSubissueTool = {
		type: 'function',
		name: 'create_subissue',
		description: 'Create a subissue for the root issue',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				parent_issue_id: { type: 'string' },
				title: { type: 'string' },
				status: { type: 'string' },
				reasoning: { type: 'string' },
				assignee_id: { type: 'string' },
				description: { type: 'string' }
			},
			required: ['parent_issue_id', 'title', 'status', 'reasoning', 'description']
		}
	};

	const draftEmailTool = {
		type: 'function',
		name: 'draft_email',
		description: 'Create or update a draft email (new outbound)',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				issue_id: { type: 'string' },
				message_id: { type: 'string' },
				recipient_email: { type: ['string', 'null'] },
				recipient_emails: { type: ['array', 'null'], items: { type: 'string' } },
				subject: { type: 'string' },
				body: { type: 'string' }
			},
			required: ['issue_id', 'subject', 'body']
		}
	};

	const draftReplyTool = {
		type: 'function',
		name: 'draft_reply',
		description: 'Create or update a draft reply to an existing email',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				issue_id: { type: 'string' },
				message_id: { type: 'string' },
				subject: { type: 'string' },
				body: { type: 'string' }
			},
			required: ['issue_id', 'message_id', 'subject', 'body']
		}
	};

	const deleteIssueTool = {
		type: 'function',
		name: 'delete_issue',
		description: 'Delete a subissue (never delete a root issue)',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				issue_id: { type: 'string' }
			},
			required: ['issue_id']
		}
	};

	const doneTool = {
		type: 'function',
		name: 'done',
		description: 'Signal that the task is complete',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				summary: { type: 'string' }
			},
			required: ['summary']
		}
	};

	const tools = [
		createIssueTool,
		linkThreadTool,
		updateIssueTool,
		createSubissueTool,
		draftEmailTool,
		draftReplyTool,
		deleteIssueTool,
		doneTool
	];

	const messagesPayload = [
		{ role: 'system', content: system },
		{
			role: 'user',
			content: JSON.stringify({
				comment,
				issue,
				related_issues: relatedIssues,
				messages,
				workspace_policy: policyText,
				workspace_units: workspaceUnits,
				vendors,
				assignees,
				admin_user_id: adminUserId,
				user_name: userName,
				default_sender_email: defaultSenderEmail
			})
		}
	];

	const actions = [];

	for (let i = 0; i < 6; i += 1) {
		const response = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${OPENAI_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: openaiModel,
				input: messagesPayload,
				tools,
				tool_choice: 'required'
			})
		});

		if (!response.ok) {
			throw new Error(await response.text());
		}

		const data = await response.json();
		const output = Array.isArray(data.output) ? data.output : [];
		for (const item of output) {
			if (item?.type === 'reasoning') {
				messagesPayload.push(item);
			}
		}
		const toolCalls = output.filter(
			(item) => item.type === 'tool_call' || item.type === 'function_call'
		);
		if (!toolCalls.length) {
			messagesPayload.push({
				role: 'assistant',
				content: 'You must call update_issue, create_subissue, or done.'
			});
			continue;
		}

		let doneCalled = false;
		for (const toolCall of toolCalls) {
			messagesPayload.push(toolCall);
			const name = toolCall.name;
			const args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
			actions.push({ name, arguments: args });
			let result = {};

			try {
				if (name === 'create_issue') {
					const title = typeof args.title === 'string' ? args.title.trim() : '';
					const unit = typeof args.unit_id === 'string' ? args.unit_id : issue.unit_id;
					const workspace =
						typeof args.workspace_id === 'string' ? args.workspace_id : issue.workspace_id;
					const assignee = resolveAssigneeId({
						requestedAssigneeId: typeof args.assignee_id === 'string' ? args.assignee_id : null,
						fallbackAssigneeId: adminUserId,
						eligibleAssignees: new Set(assignees.map((a) => a.id).filter(Boolean))
					});
					const description =
						typeof args.description === 'string' && args.description.trim()
							? args.description.trim()
							: comment;
					if (!title) {
						throw new Error('create_issue missing title');
					}
					const issueId = await createIssue({
						name: title,
						unitId: unit,
						workspaceId: workspace,
						assigneeId: assignee,
						description
					});
					result = { issue_id: issueId };
				}

				if (name === 'link_thread_to_issue') {
					const thread = typeof args.thread_id === 'string' ? args.thread_id : '';
					const issueId = typeof args.issue_id === 'string' ? args.issue_id : '';
					if (!thread || !issueId) {
						throw new Error('link_thread_to_issue missing thread_id or issue_id');
					}
					const linked = await linkThreadToIssue({ threadId: thread, issueId });
					result = { ok: linked };
				}

				if (name === 'update_issue') {
					const issueId = typeof args.issue_id === 'string' ? args.issue_id : issue.id;
					if (!issueId) {
						throw new Error('update_issue missing issue_id');
					}
					const patch = {};
					if (typeof args.name === 'string') patch.name = args.name;
					if (typeof args.status === 'string') {
						const normalized = String(args.status)
							.toLowerCase()
							.trim()
							.replace(/\s+/g, '_')
							.replace(/-/g, '_');
						const allowed = new Set(['todo', 'in_progress', 'done']);
						patch.status = allowed.has(normalized) ? normalized : 'todo';
					}
					if (typeof args.assignee_id === 'string' || args.assignee_id === null) {
						patch.assignee_id = args.assignee_id ?? null;
					}
					if (typeof args.description === 'string' || args.description === null) {
						patch.description = args.description ?? null;
					}
					if (typeof args.unit_id === 'string' || args.unit_id === null) {
						patch.unit_id = args.unit_id ?? null;
					}

					await updateIssue({ issueId, patch });
					result = { ok: true };
				}

				if (name === 'create_subissue') {
					const title = typeof args.title === 'string' ? args.title.trim() : '';
					const statusValue = typeof args.status === 'string' ? args.status : 'todo';
					const status = ['todo', 'in_progress', 'done'].includes(statusValue)
						? statusValue
						: 'todo';
					const reasoning = typeof args.reasoning === 'string' ? args.reasoning : '';
					const parentIssueId =
						typeof args.parent_issue_id === 'string' ? args.parent_issue_id : null;
					if (!title || !parentIssueId) {
						throw new Error('create_subissue missing title or parent_issue_id');
					}
					const subissueId = await createSubissue({
						parentIssueId,
						name: title,
						unitId: issue.unit_id ?? null,
						workspaceId: issue.workspace_id,
						status,
						reasoning,
						assigneeId: resolveAssigneeId({
							requestedAssigneeId: typeof args.assignee_id === 'string' ? args.assignee_id : null,
							fallbackAssigneeId: adminUserId,
							eligibleAssignees: new Set(assignees.map((a) => a.id).filter(Boolean))
						}),
						description: typeof args.description === 'string' ? args.description : null
					});
					result = { subissue_id: subissueId };
				}

				if (name === 'draft_email') {
					const issueId = typeof args.issue_id === 'string' ? args.issue_id : issue.id;
					const subject = typeof args.subject === 'string' ? args.subject : '';
					const body = typeof args.body === 'string' ? args.body : '';
					const recipientEmail =
						typeof args.recipient_email === 'string' ? args.recipient_email.trim() : null;
					const recipientEmails = Array.isArray(args.recipient_emails)
						? args.recipient_emails.map((email) => String(email ?? '').trim()).filter(Boolean)
						: null;
					if (!issueId || !subject || !body) {
						throw new Error('draft_email missing required fields');
					}
					const draftId = await upsertEmailDraft({
						issueId,
						messageId: null,
						senderEmail: defaultSenderEmail ?? null,
						recipientEmail,
						recipientEmails,
						subject,
						body
					});
					result = { draft_id: draftId };
				}

				if (name === 'draft_reply') {
					const issueId = typeof args.issue_id === 'string' ? args.issue_id : issue.id;
					const messageId = typeof args.message_id === 'string' ? args.message_id.trim() : '';
					const subject = typeof args.subject === 'string' ? args.subject : '';
					const body = typeof args.body === 'string' ? args.body : '';
					if (!issueId || !messageId || !subject || !body) {
						throw new Error('draft_reply missing required fields');
					}
					const draftId = await upsertEmailDraft({
						issueId,
						messageId,
						senderEmail: defaultSenderEmail ?? null,
						recipientEmail: null,
						recipientEmails: null,
						subject,
						body
					});
					result = { draft_id: draftId };
				}

				if (name === 'delete_issue') {
					const issueId = typeof args.issue_id === 'string' ? args.issue_id : '';
					if (!issueId) {
						throw new Error('delete_issue missing issue_id');
					}
					await deleteIssue({ issueId });
					result = { ok: true };
				}

				if (name === 'done') {
					doneCalled = true;
					result = { ok: true };
				}
			} catch (err) {
				await logAgentError({
					workspaceId: issue.workspace_id,
					issueId: issue.id,
					userId,
					action: name,
					error: err?.message ?? 'unknown',
					meta: {
						message_id: typeof args.message_id === 'string' ? args.message_id : null
					}
				});
				throw err;
			}

			messagesPayload.push({
				type: 'function_call_output',
				call_id: toolCall.call_id ?? toolCall.id,
				output: JSON.stringify(result)
			});
		}

		if (doneCalled) break;
	}

	return { actions, toolSchemas: tools };
};

const runPolicyAgent = async ({ comment, actions, toolSchemas }) => {
	const system = `You are a workspace policy agent.
Given a manager comment and the actions Bedrock can execute, decide if a new policy should be added.
If the comment implies a reusable rule ("always do X", "when Y, do Z"), write a concise policy_text.
If not, return an empty policy_text.

Rules:
- Use the tool schemas to describe allowed actions.
- Output JSON only.
`.trim();

	const response = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: openaiModel,
			input: [
				{ role: 'system', content: system },
				{
					role: 'user',
					content: JSON.stringify({ comment, actions, tool_schemas: toolSchemas })
				}
			],
			text: {
				format: {
					type: 'json_schema',
					name: 'policy_output',
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							policy_text: { type: ['string', 'null'] }
						},
						required: ['policy_text']
					}
				}
			}
		})
	});

	if (!response.ok) {
		throw new Error(await response.text());
	}

	const data = await response.json();
	const outputText = data.output_text ?? '';
	try {
		const parsed = outputText ? JSON.parse(outputText) : null;
		const policyText = typeof parsed?.policy_text === 'string' ? parsed.policy_text.trim() : '';
		return policyText;
	} catch {
		return '';
	}
};

const handleIssueAgent = async ({ payload, locals }) => {
	if (!locals?.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const issueIdRaw = typeof payload?.issue_id === 'string' ? payload.issue_id : '';
	const comment = typeof payload?.comment === 'string' ? payload.comment : '';
	console.log('agent-comment', {
		user_id: locals.user.id,
		issue_id: issueIdRaw
	});
	if (!issueIdRaw || !comment) {
		return json({ error: 'Missing issue_id or comment' }, { status: 400 });
	}

	const issueSelect =
		'id, name, status, description, parent_id, unit_id, workspace_id, assignee_id, readable_id, issue_number, reasoning';
	let issue = null;
	let issueLookupError = null;
	if (isUuid(issueIdRaw)) {
		const { data, error } = await supabaseAdmin
			.from('issues')
			.select(issueSelect)
			.eq('id', issueIdRaw)
			.maybeSingle();
		issue = data ?? null;
		issueLookupError = error ?? issueLookupError;
	}
	if (!issue) {
		const { data, error } = await supabaseAdmin
			.from('issues')
			.select(issueSelect)
			.eq('readable_id', issueIdRaw)
			.maybeSingle();
		issue = data ?? null;
		issueLookupError = error ?? issueLookupError;
	}
	if (!issue) {
		const numericId = Number(issueIdRaw);
		if (Number.isFinite(numericId)) {
			const { data, error } = await supabaseAdmin
				.from('issues')
				.select(issueSelect)
				.eq('issue_number', numericId)
				.maybeSingle();
			issue = data ?? null;
			issueLookupError = error ?? issueLookupError;
		}
	}
	if (!issue?.id || !issue.workspace_id) {
		return json(
			{
				error: 'Issue not found',
				issue_id: issueIdRaw,
				lookup_error: issueLookupError?.message ?? null
			},
			{ status: 404 }
		);
	}

	const { data: person } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('workspace_id', issue.workspace_id)
		.eq('user_id', locals.user.id)
		.in('role', ['admin', 'member', 'owner'])
		.maybeSingle();

	if (!person?.id) {
		console.log('agent-forbidden', {
			user_id: locals.user.id,
			workspace_id: issue.workspace_id
		});
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const rootIssueId = issue.parent_id ?? issue.id;
	const { data: relatedIssues } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, parent_id, unit_id, assignee_id, description, reasoning')
		.or(`id.eq.${rootIssueId},parent_id.eq.${rootIssueId}`);

	const relatedIds = (relatedIssues ?? []).map((row) => row.id).filter(Boolean);
	const { data: messages } = relatedIds.length
		? await supabaseAdmin
				.from('messages')
				.select('id, issue_id, subject, message, sender, timestamp')
				.in('issue_id', relatedIds)
				.order('timestamp', { ascending: false })
				.limit(20)
		: { data: [] };

	const { data: policyRow } = await supabaseAdmin
		.from('workspace_policies')
		.select('policy_text')
		.eq('workspace_id', issue.workspace_id)
		.in('type', ['behavior', 'allow'])
		.order('updated_at', { ascending: false })
		.limit(1)
		.maybeSingle();
	const policyText = policyRow?.policy_text ?? '';

	const vendors = await listVendors(issue.workspace_id);
	const assignees = await listWorkspaceAssignees(issue.workspace_id);
	const adminUserId = await getWorkspaceAdminId(issue.workspace_id);
	const userName = await getUserNameById(locals.user.id);
	const defaultSenderEmail = await getDefaultSenderEmail(locals.user.id);
	const workspaceUnits = await listWorkspaceUnitsForAgent(issue.workspace_id);

	let actions = [];
	let toolSchemas = [];
	try {
		const runResult = await runIssueAgentFromComment({
			issue,
			comment,
			relatedIssues: relatedIssues ?? [],
			messages: messages ?? [],
			policyText,
			workspaceUnits,
			vendors,
			assignees,
			adminUserId,
			userName,
			defaultSenderEmail,
			userId: locals.user.id
		});
		actions = runResult.actions;
		toolSchemas = runResult.toolSchemas;
	} catch (err) {
		await logAgentError({
			workspaceId: issue.workspace_id,
			issueId: issue.id,
			userId: locals.user.id,
			action: 'agent_run',
			error: err?.message ?? 'unknown'
		});
		throw err;
	}

	let policyTextCandidate = await runPolicyAgent({
		comment,
		actions,
		toolSchemas
	});

	if (!policyTextCandidate) {
		const normalized = comment.toLowerCase();
		const shouldPromote =
			normalized.includes('always') ||
			normalized.includes('from now on') ||
			normalized.includes('going forward') ||
			normalized.includes('in the future') ||
			normalized.includes('every time') ||
			normalized.includes('never') ||
			normalized.includes('whenever') ||
			normalized.includes('if ') ||
			normalized.includes('when ');
		if (shouldPromote) {
			policyTextCandidate = comment.trim();
		}
	}

	if (policyTextCandidate) {
		await supabaseAdmin.from('workspace_policies').insert({
			workspace_id: issue.workspace_id,
			type: 'behavior',
			policy_text: policyTextCandidate,
			description: comment.slice(0, 500),
			created_by: locals.user.id,
			updated_at: new Date().toISOString()
		});
	}

	return json({ status: 'ok' });
};

const insertIngestionLog = async ({ userId, source, detail }) => {
	const trimmed = detail.slice(0, 4000);
	const { error } = await supabaseAdmin
		.schema('errors')
		.from('ingestion_errors')
		.insert({ user_id: userId, source, detail: trimmed });
	if (error) {
		console.error('gmail-agent log insert failed', error);
	}
};

const logError = async (userId, detail) => {
	await insertIngestionLog({ userId, source: 'gmail-push', detail });
};

const logLlmOutput = async (userId, payload, runId, step) => {
	try {
		await insertIngestionLog({
			userId,
			source: 'gmail-llm',
			detail: JSON.stringify({ run_id: runId, step, output: payload })
		});
		console.log('agent-llm', {
			user_id: userId,
			run_id: runId,
			step
		});
	} catch (err) {
		console.error('gmail-agent llm log failed', err);
	}
};

const logAgentErrorForGmail = async ({
	workspaceId,
	issueId,
	userId,
	action,
	error,
	messageId,
	runId,
	step
}) => {
	if (!workspaceId || !userId) return;
	const { error: insertError } = await supabaseAdmin.from('activity_logs').insert({
		workspace_id: workspaceId,
		issue_id: issueId ?? null,
		type: 'agent-error',
		data: {
			action,
			error,
			message_id: messageId ?? null,
			run_id: runId ?? null,
			step: Number.isFinite(step) ? step : null
		},
		created_by: userId
	});
	if (insertError) {
		console.error('agent-error log insert failed', insertError);
	}
};

const createDraftNotification = async ({
	workspaceId,
	issueId,
	issueName,
	emailDraftId,
	messageId,
	userId
}) => {
	let resolvedIssueName = issueName?.trim() ?? '';
	if (!resolvedIssueName) {
		const { data: issueRow } = await supabaseAdmin
			.from('issues')
			.select('name')
			.eq('id', issueId)
			.maybeSingle();
		resolvedIssueName = issueRow?.name?.trim() ?? '';
	}

	const { data: workspaceRow } = await supabaseAdmin
		.from('workspaces')
		.select('admin_user_id')
		.eq('id', workspaceId)
		.maybeSingle();
	const adminUserId = workspaceRow?.admin_user_id ?? null;
	if (!adminUserId) {
		await insertIngestionLog({
			userId,
			source: 'notification',
			detail: JSON.stringify({
				reason: 'missing_workspace_admin',
				workspace_id: workspaceId,
				issue_id: issueId
			})
		});
		return;
	}

	const safeIssueName = resolvedIssueName || 'this issue';
	const body = `Bedrock drafted an email for ${safeIssueName}.`;
	const { error } = await supabaseAdmin.from('notifications').insert({
		workspace_id: workspaceId,
		issue_id: issueId,
		user_id: adminUserId,
		title: 'Email Drafted',
		body,
		type: 'email_draft_made',
		requires_action: false,
		meta: {
			email_draft_id: emailDraftId,
			message_id: messageId
		}
	});
	if (error) {
		await insertIngestionLog({
			userId,
			source: 'notification',
			detail: JSON.stringify({
				reason: 'insert_failed',
				workspace_id: workspaceId,
				issue_id: issueId,
				error: error.message
			})
		});
	}
};

const listOpenIssues = async (unitId) => {
	if (!unitId) return [];
	const { data } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, parent_id, updated_at')
		.eq('unit_id', unitId)
		.in('status', ['todo', 'in_progress'])
		.order('updated_at', { ascending: false })
		.limit(25);
	return data ?? [];
};

const listEligibleAssigneesForGmail = async (workspaceId) => {
	const { data } = await supabaseAdmin
		.from('members')
		.select('user_id, role')
		.eq('workspace_id', workspaceId)
		.in('role', ['admin', 'member', 'owner']);
	const ids = (data ?? []).map((row) => row.user_id).filter((id) => typeof id === 'string');
	return new Set(ids);
};

const listWorkspaceAssigneesForGmail = async (workspaceId) => {
	const { data: members } = await supabaseAdmin
		.from('members')
		.select('user_id, role')
		.eq('workspace_id', workspaceId)
		.in('role', ['admin', 'member', 'owner']);
	const memberIds = (members ?? [])
		.map((row) => row.user_id)
		.filter((id) => typeof id === 'string');
	if (!memberIds.length) return [];

	const { data: users } = await supabaseAdmin.from('users').select('id, name').in('id', memberIds);
	return (users ?? []).map((user) => ({
		id: typeof user.id === 'string' ? user.id : String(user.id ?? ''),
		name: typeof user.name === 'string' ? user.name : null
	}));
};

const logAgentAssigneeChange = async ({ workspaceId, issueId, assigneeId }) => {
	if (!workspaceId || !issueId || !assigneeId) return;
	await supabaseAdmin.from('activity_logs').insert({
		workspace_id: workspaceId,
		issue_id: issueId,
		type: 'assignee_change',
		data: {
			from: null,
			to: assigneeId
		},
		created_by: null
	});
};

const createIssueForGmail = async ({ name, unitId, workspaceId, assigneeId, description }) => {
	const { data, error } = await supabaseAdmin
		.from('issues')
		.insert({
			name,
			unit_id: unitId ?? null,
			workspace_id: workspaceId,
			status: 'todo',
			assignee_id: assigneeId ?? null,
			description: description ?? null
		})
		.select('id')
		.single();
	if (error || !data?.id) {
		throw new Error(error?.message ?? 'Issue insert failed');
	}
	await logAgentAssigneeChange({
		workspaceId,
		issueId: data.id,
		assigneeId
	});
	return data.id;
};

const buildIssueDescriptionFallback = ({ status, assigneeName, subject, body }) => {
	const normalizedSubject = subject?.trim() ?? '';
	const normalizedBody = body?.trim().replace(/\s+/g, ' ') ?? '';
	const snippet = normalizedBody ? normalizedBody.slice(0, 120) : '';
	const assigneeLabel = assigneeName?.trim() ? assigneeName.trim() : 'Unassigned';
	const threadPart =
		normalizedSubject || snippet
			? `Thread: ${[
					normalizedSubject,
					snippet ? `"${snippet}${normalizedBody.length > 120 ? '...' : ''}"` : null
				]
					.filter(Boolean)
					.join(' — ')}`
			: 'Thread: N/A';
	return `Status: ${status}. Assignee: ${assigneeLabel}. ${threadPart}.`;
};

const buildRootIssueDescriptionFallback = ({
	reporterName,
	assigneeName,
	subject,
	body,
	issueTitle
}) => {
	const normalizedSubject = subject?.trim() ?? '';
	const normalizedBody = body?.trim().replace(/\s+/g, ' ') ?? '';
	const snippet = normalizedBody ? normalizedBody.slice(0, 120) : '';
	const reporterLabel = reporterName?.trim()
		? reporterName.trim()
		: assigneeName?.trim()
			? assigneeName.trim()
			: 'Someone';
	const cleanedTitle = issueTitle?.trim() ?? '';
	const subjectOrSnippet = normalizedSubject || snippet;
	const detail = cleanedTitle || subjectOrSnippet || 'a maintenance issue';
	return `${reporterLabel} reports ${detail}.`;
};

const buildSubissueDescriptionFallback = ({ name, reasoning }) => {
	const normalizedReasoning = reasoning?.trim() ?? '';
	const trimmedName = name.trim();
	const issueTitleFromName = trimmedName
		.replace(/^triage\s+/i, '')
		.replace(/^schedule\s+/i, '')
		.replace(/\s*\([^)]*\)\s*$/i, '')
		.replace(/^.*?\s+for\s+/i, '')
		.trim();
	const isTriage = /^triage\s+/i.test(trimmedName);
	const isSchedule = /^schedule\s+/i.test(trimmedName);

	if (normalizedReasoning) {
		const cleaned = normalizedReasoning
			.replace(/^initial triage:\s*/i, '')
			.replace(/^triage:\s*/i, '')
			.replace(/^schedule:\s*/i, '')
			.replace(/^tenant reports\b[^.;:]*[.;:]\s*/i, '')
			.replace(/\bask clarifying questions\b/gi, 'collect details')
			.replace(/\bsuggest basic troubleshooting\b/gi, 'try basic steps')
			.replace(/\s+/g, ' ')
			.trim();
		if (cleaned) return cleaned;
	}
	if (isTriage) {
		const issueTitle = issueTitleFromName || 'issue';
		return `${issueTitle} seems tenant-fixable, starting triage.`;
	}
	if (isSchedule) {
		const issueTitle = issueTitleFromName || 'issue';
		return `Tenant cannot resolve ${issueTitle}, scheduling vendor.`;
	}
	return `${trimmedName} created.`;
};

const normalizeOneLine = (value, maxLength = 180) => {
	const cleaned = (value ?? '').replace(/\s+/g, ' ').trim();
	if (!cleaned) return '';
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3))}...`;
};

const ensureSentence = (value) => {
	const trimmed = value.trim();
	if (!trimmed) return '';
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const isStatusListDescription = (value) => /^(todo|in_progress|done)[,;:]/i.test(value);

const createSubissueForGmail = async ({
	parentIssueId,
	name,
	unitId,
	workspaceId,
	status,
	reasoning,
	assigneeId,
	description
}) => {
	const { data, error } = await supabaseAdmin
		.from('issues')
		.insert({
			parent_id: parentIssueId,
			name,
			unit_id: unitId ?? null,
			workspace_id: workspaceId,
			status,
			reasoning,
			assignee_id: assigneeId ?? null,
			description: description ?? null
		})
		.select('id')
		.single();
	if (error || !data?.id) {
		throw new Error(error?.message ?? 'Subissue insert failed');
	}
	await logAgentAssigneeChange({
		workspaceId,
		issueId: data.id,
		assigneeId
	});
	return data.id;
};

const upsertEmailDraftForGmail = async ({
	issueId,
	messageId,
	senderEmail,
	recipientEmail,
	recipientEmails,
	subject,
	body,
	userId,
	workspaceId
}) => {
	const normalizedRecipients = Array.isArray(recipientEmails)
		? recipientEmails.map((email) => String(email ?? '').trim()).filter(Boolean)
		: [];
	const fallbackRecipient = typeof recipientEmail === 'string' ? recipientEmail.trim() : '';
	if (!normalizedRecipients.length && fallbackRecipient) {
		normalizedRecipients.push(fallbackRecipient);
	}
	const payload = {
		issue_id: issueId,
		message_id: messageId,
		sender_email: senderEmail,
		recipient_email: normalizedRecipients[0] ?? recipientEmail,
		recipient_emails: normalizedRecipients.length ? normalizedRecipients : null,
		subject,
		body,
		workspace_id: workspaceId,
		updated_at: new Date().toISOString()
	};

	let error = null;
	let draftId = null;
	let created = false;
	if (messageId) {
		const { data: existingDraft } = await supabaseAdmin
			.from('email_drafts')
			.select('id')
			.eq('message_id', messageId)
			.maybeSingle();
		if (existingDraft?.id) {
			const result = await supabaseAdmin
				.from('email_drafts')
				.update(payload)
				.eq('id', existingDraft.id);
			draftId = existingDraft.id;
			error = result.error;
		} else {
			const result = await supabaseAdmin.from('email_drafts').insert(payload).select('id').single();
			draftId = result.data?.id ?? null;
			error = result.error;
			created = true;
		}
	} else {
		const { data: existingDraft } = await supabaseAdmin
			.from('email_drafts')
			.select('id')
			.eq('issue_id', issueId)
			.is('message_id', null)
			.maybeSingle();
		if (existingDraft?.id) {
			const result = await supabaseAdmin
				.from('email_drafts')
				.update(payload)
				.eq('id', existingDraft.id);
			draftId = existingDraft.id;
			error = result.error;
		} else {
			const result = await supabaseAdmin.from('email_drafts').insert(payload).select('id').single();
			draftId = result.data?.id ?? null;
			error = result.error;
			created = true;
		}
	}
	if (error) {
		await insertIngestionLog({
			userId,
			source: 'gmail-draft-error',
			detail: JSON.stringify({
				issue_id: issueId,
				message_id: messageId,
				error: error.message
			})
		});
		throw new Error(error.message);
	}
	if (!draftId) {
		throw new Error('Email draft id missing');
	}
	await insertIngestionLog({
		userId,
		source: 'gmail-draft',
		detail: JSON.stringify({ issue_id: issueId, message_id: messageId })
	});
	console.log('agent-draft', {
		issue_id: issueId,
		message_id: messageId,
		created
	});
	return { draftId, created };
};

const generateIssueTitle = async ({ subject, body, senderEmail, unitId, workspaceId }) => {
	const system = `Generate a concise maintenance issue title.
Rules:
- 2-5 words
- Title Case
- No location names
- Describe the maintenance problem
`.trim();

	const response = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: openaiModel,
			input: [
				{ role: 'system', content: system },
				{
					role: 'user',
					content: JSON.stringify({
						subject,
						body,
						sender_email: senderEmail,
						unit_id: unitId,
						workspace_id: workspaceId
					})
				}
			],
			text: {
				format: {
					type: 'json_schema',
					name: 'issue_title',
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							title: { type: 'string' }
						},
						required: ['title']
					}
				}
			}
		})
	});

	if (!response.ok) {
		throw new Error(await response.text());
	}

	const data = await response.json();
	const outputText = data.output_text ?? '';
	try {
		const parsed = outputText ? JSON.parse(outputText) : null;
		if (parsed?.title && typeof parsed.title === 'string') {
			return parsed.title.trim();
		}
	} catch {
		// ignore
	}
	return '';
};

const runGmailIssueAgent = async ({
	subject,
	body,
	senderEmail,
	unitId,
	unitName,
	workspaceId,
	propertyName,
	threadId,
	userId,
	policyText,
	tenantName,
	tenantEmail,
	userName,
	defaultSenderEmail,
	replyMessageId,
	rootIssueId,
	threadIssueId,
	relatedIssues,
	workspaceUnits
}) => {
	const system = `You are Bedrock, an assistant for property management.
Your job is to link this email thread to the most specific issue (prefer a subissue when appropriate). If no match exists, create a new issue and then create one subissue for the next step.

Process (required):
1) Review the provided open_issues list.
2) If root_issue_id is provided, do not create a new issue. Use it as the root issue id.
3) If no existing_issue_id is provided and no clear match exists, call create_issue with a concise title.
4) If existing_issue_id is provided, prefer reusing the most recent triage subissue from open_issues that matches the issue. Only create a new triage subissue if no suitable triage subissue exists.
5) If the tenant indicates troubleshooting failed or the issue cannot be resolved by the tenant, create a Schedule subissue for a vendor (even if you reused the triage subissue) and shift the workflow to scheduling. This is a stopping point: do not continue triage back-and-forth.
6) If the email is from a tenant, follow staged triage:
   - Stage 1: Identify if the tenant can resolve the issue themselves with basic steps.
   - Stage 2: Determine if a vendor is needed.
   - Stage 3: Determine if it is an emergency.
   Use the full conversation thread for context and ask clarifying questions to confirm urgency.
   Choose triage when the tenant might resolve it or more info is needed; choose schedule only for clear emergencies (e.g., pests, gas smell, no power, no water, flooding, safety risks) or when workspace_policy explicitly requires immediate scheduling.
   Example: a clogged toilet is typically triage (suggest using a plunger and ask if there is overflow/flooding). If there is flooding or safety risk, treat as emergency and schedule.
7) If you created a triage subissue, create an email draft reply to the tenant using draft_reply (required).
8) When you determine the tenant cannot resolve the issue and you create a Schedule subissue, you should create two drafts in the same run:
   - Tenant reply: acknowledge, confirm availability/entry permission, and keep the tenant informed. Use latest_message_id for message_id.
    - Vendor request: pick a vendor from the vendors list (prefer trade match) and draft a vendor email. Omit message_id unless a vendor thread exists. If no suitable vendor or no vendor email exists, draft with recipient_email null and note that no matching vendor was found.
   This is a stopping point for triage: do not keep asking tenant troubleshooting questions in the same run.
9) Linking: Always link the tenant thread to the triage subissue (or existing triage subissue). Do NOT link the tenant thread to the Schedule subissue; that subissue is for the vendor thread.
10) Finally, call link_thread_to_issue once with the triage subissue id. This is required.

Non-tenant routing:
- If tenant_name is null and workspace_units are provided, infer the most likely unit_id from the email subject/body.
- Use property/unit hints in the email to pick a unit_id from workspace_units.
- If there is no confident match, set unit_id to null.

Rules:
- Use tools only.
- Issue title: 2-5 words, Title Case, no location or unit/building names.
- Issue description: required when creating an issue. One line only, super concise, human readable summary of the current state. Include who reported it (name if known) and what the issue is. Avoid quoting the email body. Avoid list/CSV formatting; write a sentence.
- Status must be 'todo' when creating a new issue.
- Subissue title format:
  - Triage {Issue Title} (${tenantName ?? 'Tenant'})
  - Schedule {Vendor Type} for {Issue Title}
- Subissue parent rules: Triage and Schedule subissues must use root_issue_id as parent. Never use thread_issue_id as the parent for Schedule.
- Subissue description: required. One line only, super concise, human readable summary of why this subissue exists (use the reasoning as a base). Make it specific to the subissue stage (triage vs schedule) and the reason for that stage (tenant-fixable, policy requirement, etc.). Avoid quoting the email body. Avoid list/CSV formatting; write a sentence.
- Reasoning: keep as a short, human-readable sentence that can be reused for the subissue description.
- Use the workspace_policy to decide triage vs schedule vendor. If the policy instructs drafting emails to cleaners or vendors, do that and skip draft_reply unless the policy explicitly says to reply.
- Drafts: Always write from the property manager POV (the user). Never write from the tenant POV.
- Drafts: For tenant replies, address the tenant by tenant_name only. Never infer a name from the email address.
- Drafts: End with the user_name as the signature. Never use an email address as the signature.
- Drafts: Never use default_sender_email in the email body.
- Drafts: When referencing location, use property_name and unit_name (e.g., "at {property_name}, unit {unit_name}"). Never include a raw UUID in the email body.
- Drafts: When triaging, draft a short, friendly reply acknowledging the issue and asking one clarifying question about emergency indicators if relevant.
- Drafts: When scheduling, draft a short, direct vendor email requesting availability and permission to access.
- Drafts: Use draft_reply for replies and draft_email for new outbound emails.
- Drafts: For Schedule subissues, the draft recipient must be a vendor email or null; never send to sender_email.
- Drafts: sender_email should not be provided by the agent. The system will use default_sender_email.
- Drafts: When provided, pass recipient_email as a plain email address (no display name).
- Drafts: If emailing multiple recipients, pass recipient_emails as an array of plain email addresses.
- root_issue_id: When present, you must not call create_issue. Reuse existing subissues when possible.
- Drafts: Use the subissue id for issue_id. For replies, use latest_message_id for message_id. For vendor scheduling drafts, use draft_email for new outreach and draft_reply for replies; include message_id only when replying in an existing vendor thread, otherwise omit it entirely (do not send empty string).
- Linking: Call link_thread_to_issue exactly once and only after issue/subissue creation. This is required.
- Assignees: When creating issues/subissues, set assignee_id to a user id from eligible_assignees. If unsure, omit it and default to admin_user_id.
Tenant identity:
- tenant_name and tenant_email come from the tenants table lookup by sender email. These are authoritative.
User identity:
- user_name is the property manager name. You are drafting on behalf of user_name.
Issue context:
- root_issue_id is the root issue for this thread.
- thread_issue_id is the issue currently linked to the email thread (often triage).
- related_issues are the root issue and its subissues; use them to reason about structure.
When you believe you have completed the task, call done().
`.trim();
	const createIssueTool = {
		type: 'function',
		name: 'create_issue',
		description: 'Create a new issue',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				title: { type: 'string' },
				unit_id: { type: ['string', 'null'] },
				workspace_id: { type: 'string' },
				assignee_id: { type: 'string' },
				description: { type: 'string' }
			},
			required: ['title', 'workspace_id', 'description']
		}
	};
	const linkThreadTool = {
		type: 'function',
		name: 'link_thread_to_issue',
		description: 'Attach a thread to an issue',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				thread_id: { type: 'string' },
				issue_id: { type: 'string' }
			},
			required: ['thread_id', 'issue_id']
		}
	};
	const createSubissueTool = {
		type: 'function',
		name: 'create_subissue',
		description: 'Create a subissue for a root issue',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				parent_issue_id: { type: 'string' },
				title: { type: 'string' },
				status: { type: 'string' },
				reasoning: { type: 'string' },
				assignee_id: { type: 'string' },
				description: { type: 'string' }
			},
			required: ['parent_issue_id', 'title', 'status', 'reasoning', 'description']
		}
	};
	const draftEmailTool = {
		type: 'function',
		name: 'draft_email',
		description: 'Create or update a draft email (new outbound)',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				issue_id: { type: 'string' },
				message_id: { type: 'string' },
				recipient_email: { type: 'string' },
				recipient_emails: { type: 'array', items: { type: 'string' } },
				subject: { type: 'string' },
				body: { type: 'string' }
			},
			required: ['issue_id', 'subject', 'body']
		}
	};
	const draftReplyTool = {
		type: 'function',
		name: 'draft_reply',
		description: 'Create or update a draft reply to an existing email',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				issue_id: { type: 'string' },
				message_id: { type: 'string' },
				subject: { type: 'string' },
				body: { type: 'string' }
			},
			required: ['issue_id', 'message_id', 'subject', 'body']
		}
	};
	const doneTool = {
		type: 'function',
		name: 'done',
		description: 'Signal that the task is complete',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				summary: { type: 'string' }
			},
			required: ['summary']
		}
	};

	const tools = [
		...(rootIssueId ? [] : [createIssueTool]),
		linkThreadTool,
		createSubissueTool,
		draftEmailTool,
		draftReplyTool,
		doneTool
	];

	const openIssues = await listOpenIssues(unitId);
	const vendors = await listVendors(workspaceId);
	const workspaceAdminId = await getWorkspaceAdminId(workspaceId);
	const eligibleAssignees = await listEligibleAssigneesForGmail(workspaceId);
	const assignees = await listWorkspaceAssigneesForGmail(workspaceId);
	const assigneeNameById = new Map(
		assignees.map((assignee) => [assignee.id, assignee.name ?? null])
	);
	if (workspaceAdminId && !assigneeNameById.has(workspaceAdminId)) {
		const adminName = await getUserNameById(workspaceAdminId);
		assigneeNameById.set(workspaceAdminId, adminName);
		assignees.push({ id: workspaceAdminId, name: adminName });
	}
	if (workspaceAdminId) {
		eligibleAssignees.add(workspaceAdminId);
	}
	const messages = [
		{ role: 'system', content: system },
		{
			role: 'user',
			content: JSON.stringify({
				subject,
				body,
				sender_email: senderEmail,
				unit_id: unitId,
				unit_name: unitName,
				workspace_id: workspaceId,
				property_name: propertyName,
				thread_id: threadId,
				latest_message_id: replyMessageId,
				root_issue_id: rootIssueId ?? null,
				thread_issue_id: threadIssueId ?? null,
				related_issues: relatedIssues ?? [],
				open_issues: openIssues,
				vendors,
				workspace_policy: policyText,
				tenant_name: tenantName,
				tenant_email: tenantEmail,
				user_name: userName,
				default_sender_email: defaultSenderEmail,
				eligible_assignees: Array.from(eligibleAssignees),
				assignees,
				admin_user_id: workspaceAdminId,
				workspace_units: workspaceUnits ?? []
			})
		}
	];

	const runId = crypto.randomUUID();
	let linkedIssueId = null;
	let createdIssueId = null;
	let lastSubissueId = null;
	let lastSubissueTitle = null;
	let draftedIssueId = null;
	let threadLinked = false;
	let resolvedUnitId = unitId;
	const issueNameCache = new Map();

	for (let i = 0; i < 6; i += 1) {
		const response = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${OPENAI_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: openaiModel,
				input: messages,
				tools,
				tool_choice: 'required'
			})
		});

		if (!response.ok) {
			throw new Error(await response.text());
		}

		const data = await response.json();
		await logLlmOutput(userId, data.output ?? data, runId, i);
		const output = Array.isArray(data.output) ? data.output : [];
		for (const item of output) {
			if (item?.type === 'reasoning') {
				messages.push(item);
			}
		}
		const toolCalls = output.filter(
			(item) => item.type === 'tool_call' || item.type === 'function_call'
		);
		if (!toolCalls.length) {
			messages.push({
				role: 'assistant',
				content: rootIssueId
					? 'You must call create_subissue or link_thread_to_issue.'
					: 'You must call create_issue or link_thread_to_issue. Use create_issue if no clear match.'
			});
			continue;
		}

		let issuedAction = false;
		let doneCalled = false;
		for (const toolCall of toolCalls) {
			messages.push(toolCall);
			const name = toolCall.name;
			const args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
			let result = {};
			try {
				if (name === 'create_issue') {
					const title = typeof args.title === 'string' ? args.title.trim() : '';
					const unit = typeof args.unit_id === 'string' ? args.unit_id : unitId;
					const workspace = typeof args.workspace_id === 'string' ? args.workspace_id : workspaceId;
					const assignee = resolveAssigneeId({
						requestedAssigneeId: typeof args.assignee_id === 'string' ? args.assignee_id : null,
						fallbackAssigneeId: workspaceAdminId,
						eligibleAssignees
					});
					const rawDescriptionCandidate =
						typeof args.description === 'string'
							? normalizeOneLine(ensureSentence(args.description.replace(/"/g, '')))
							: '';
					const rawDescription = isStatusListDescription(rawDescriptionCandidate)
						? ''
						: rawDescriptionCandidate;
					const assigneeName = assignee ? (assigneeNameById.get(assignee) ?? null) : null;
					const description = rawDescription
						? rawDescription
						: normalizeOneLine(
								ensureSentence(
									buildRootIssueDescriptionFallback({
										reporterName: tenantName ?? null,
										assigneeName,
										subject,
										body,
										issueTitle: title
									})
								)
							);
					if (!title) {
						throw new Error('create_issue missing title');
					}
					const issueId = await createIssueForGmail({
						name: title,
						unitId: unit,
						workspaceId: workspace,
						assigneeId: assignee,
						description
					});
					if (unit && typeof unit === 'string') {
						resolvedUnitId = unit;
					}
					linkedIssueId = issueId;
					createdIssueId = issueId;
					issuedAction = true;
					result = { issue_id: issueId };
				}

				if (name === 'link_thread_to_issue') {
					const thread = typeof args.thread_id === 'string' ? args.thread_id : threadId;
					const issue =
						typeof args.issue_id === 'string' ? args.issue_id : (lastSubissueId ?? linkedIssueId);
					if (!thread || !issue) {
						throw new Error('link_thread_to_issue missing thread_id or issue_id');
					}
					const linked = await linkThreadToIssue({ threadId: thread, issueId: issue });
					if (!linked) {
						const { data: existingThread } = await supabaseAdmin
							.from('threads')
							.select('issue_id')
							.eq('id', thread)
							.maybeSingle();
						linkedIssueId = existingThread?.issue_id ?? issue;
					} else {
						linkedIssueId = issue;
					}
					threadLinked = true;
					issuedAction = true;
					result = { ok: linked };
				}

				if (name === 'create_subissue') {
					const title = typeof args.title === 'string' ? args.title.trim() : '';
					const statusValue = typeof args.status === 'string' ? args.status : 'todo';
					const status = ['todo', 'in_progress', 'done'].includes(statusValue)
						? statusValue
						: 'todo';
					const reasoning = typeof args.reasoning === 'string' ? args.reasoning : '';
					const requestedParent =
						typeof args.parent_issue_id === 'string' ? args.parent_issue_id : null;
					const assignee = resolveAssigneeId({
						requestedAssigneeId: typeof args.assignee_id === 'string' ? args.assignee_id : null,
						fallbackAssigneeId: workspaceAdminId,
						eligibleAssignees
					});
					const rawDescriptionCandidate =
						typeof args.description === 'string'
							? normalizeOneLine(ensureSentence(args.description.replace(/"/g, '')))
							: '';
					const rawDescription = isStatusListDescription(rawDescriptionCandidate)
						? ''
						: rawDescriptionCandidate;
					const description = rawDescription
						? rawDescription
						: normalizeOneLine(
								ensureSentence(
									buildSubissueDescriptionFallback({ name: title || 'Subissue', reasoning })
								)
							);
					const parentIssueId = requestedParent ?? linkedIssueId ?? createdIssueId;
					if (!title || !parentIssueId) {
						throw new Error('create_subissue missing title or parent_issue_id');
					}
					const subissueId = await createSubissueForGmail({
						parentIssueId,
						name: title,
						unitId: resolvedUnitId ?? null,
						workspaceId,
						status,
						reasoning,
						assigneeId: assignee,
						description
					});
					lastSubissueId = subissueId;
					lastSubissueTitle = title;
					issuedAction = true;
					result = { subissue_id: subissueId };
				}

				if (name === 'draft_email') {
					const issue = typeof args.issue_id === 'string' ? args.issue_id : lastSubissueId;
					const senderEmailToUse = defaultSenderEmail ? normalizeEmail(defaultSenderEmail) : '';
					const recipientList = Array.isArray(args.recipient_emails)
						? args.recipient_emails.map((email) => String(email ?? '').trim()).filter(Boolean)
						: [];
					let recipient =
						typeof args.recipient_email === 'string'
							? args.recipient_email
							: typeof args.recipient === 'string'
								? args.recipient
								: '';
					const subjectValue = typeof args.subject === 'string' ? args.subject : '';
					const bodyText = typeof args.body === 'string' ? args.body : '';
					if (!issue || !subjectValue || !bodyText) {
						throw new Error('draft_email missing required fields');
					}
					if (!senderEmailToUse) {
						throw new Error('draft_email missing default_sender_email');
					}

					let issueName = issueNameCache.get(issue) ?? '';
					if (!issueName) {
						const { data: issueRow } = await supabaseAdmin
							.from('issues')
							.select('name')
							.eq('id', issue)
							.maybeSingle();
						issueName = issueRow?.name ?? '';
						if (issueName) issueNameCache.set(issue, issueName);
					}
					const isScheduleSubissue = issueName.startsWith('Schedule ');
					const messageId = null;
					let normalizedRecipient = recipient ? normalizeEmail(extractEmail(recipient)) : null;
					const normalizedRecipientList = recipientList
						.map((email) => normalizeEmail(extractEmail(email)))
						.filter((email) => email && email.includes('@'));
					const normalizedSenderEmail = senderEmail ? normalizeEmail(senderEmail) : null;
					if (normalizedRecipient && !normalizedRecipient.includes('@')) {
						normalizedRecipient = null;
					}
					if (
						isScheduleSubissue &&
						normalizedSenderEmail &&
						normalizedRecipient &&
						normalizedRecipient === normalizedSenderEmail
					) {
						normalizedRecipient = null;
						await insertIngestionLog({
							userId,
							source: 'gmail-draft-error',
							detail: JSON.stringify({
								issue_id: issue,
								message_id: messageId,
								reason: 'schedule draft recipient matched sender'
							})
						});
					}
					if (!normalizedRecipient && !normalizedRecipientList.length && !isScheduleSubissue) {
						throw new Error('draft_email missing recipient_email');
					}
					try {
						const draftResult = await upsertEmailDraftForGmail({
							issueId: issue,
							messageId,
							senderEmail: senderEmailToUse,
							recipientEmail: normalizedRecipient,
							recipientEmails: normalizedRecipientList.length
								? normalizedRecipientList
								: normalizedRecipient
									? [normalizedRecipient]
									: null,
							subject: subjectValue,
							body: bodyText,
							userId,
							workspaceId
						});
						if (draftResult.created) {
							await createDraftNotification({
								workspaceId,
								issueId: issue,
								issueName,
								emailDraftId: draftResult.draftId,
								messageId,
								userId
							});
						}
					} catch (err) {
						await insertIngestionLog({
							userId,
							source: 'gmail-draft-error',
							detail: JSON.stringify({
								issue_id: issue,
								message_id: messageId,
								error: err?.message ?? 'draft insert failed'
							})
						});
						await logAgentErrorForGmail({
							workspaceId,
							issueId: issue,
							userId,
							action: 'draft_email',
							error: err?.message ?? 'draft insert failed',
							messageId,
							runId,
							step: i
						});
					}
					draftedIssueId = issue;
					issuedAction = true;
					result = { ok: true };
				}

				if (name === 'draft_reply') {
					const issue = typeof args.issue_id === 'string' ? args.issue_id : lastSubissueId;
					const messageId = typeof args.message_id === 'string' ? args.message_id.trim() : '';
					const subjectValue = typeof args.subject === 'string' ? args.subject : '';
					const bodyText = typeof args.body === 'string' ? args.body : '';
					const senderEmailToUse = defaultSenderEmail ? normalizeEmail(defaultSenderEmail) : '';
					if (!issue || !messageId || !subjectValue || !bodyText) {
						throw new Error('draft_reply missing required fields');
					}
					if (!senderEmailToUse) {
						throw new Error('draft_reply missing default_sender_email');
					}

					const { data: messageRow } = await supabaseAdmin
						.from('messages')
						.select('id, thread_id')
						.eq('id', messageId)
						.maybeSingle();
					if (!messageRow?.thread_id) {
						throw new Error('draft_reply message not found');
					}

					const { data: threadRow } = await supabaseAdmin
						.from('threads')
						.select('id, issue_id, participant_type, participant_id, tenant_id')
						.eq('id', messageRow.thread_id)
						.maybeSingle();
					if (!threadRow?.id) {
						throw new Error('draft_reply thread not found');
					}
					const issueIdForReply = threadRow.issue_id ?? issue;

					let issueName = issueNameCache.get(issueIdForReply) ?? '';
					if (!issueName) {
						const { data: issueRow } = await supabaseAdmin
							.from('issues')
							.select('name')
							.eq('id', issueIdForReply)
							.maybeSingle();
						issueName = issueRow?.name ?? '';
						if (issueName) issueNameCache.set(issueIdForReply, issueName);
					}

					let recipientEmail = '';
					if (threadRow.participant_type === 'tenant') {
						const tenantId = threadRow.tenant_id ?? threadRow.participant_id;
						if (!tenantId) {
							throw new Error('draft_reply missing tenant_id');
						}
						const { data: tenantRow } = await supabaseAdmin
							.from('tenants')
							.select('email')
							.eq('id', tenantId)
							.maybeSingle();
						recipientEmail = tenantRow?.email ?? '';
					} else if (threadRow.participant_type === 'vendor') {
						const vendorId = threadRow.participant_id;
						if (!vendorId) {
							throw new Error('draft_reply missing vendor_id');
						}
						const { data: vendorRow } = await supabaseAdmin
							.from('people')
							.select('email')
							.eq('id', vendorId)
							.eq('role', 'vendor')
							.maybeSingle();
						recipientEmail = vendorRow?.email ?? '';
					} else if (threadRow.participant_type === 'unknown') {
						recipientEmail = senderEmail ?? '';
					} else {
						throw new Error('draft_reply unsupported participant type');
					}

					const normalizedRecipient = recipientEmail
						? normalizeEmail(extractEmail(recipientEmail))
						: null;
					if (!normalizedRecipient || !normalizedRecipient.includes('@')) {
						throw new Error('draft_reply recipient invalid');
					}

					try {
						const draftResult = await upsertEmailDraftForGmail({
							issueId: issueIdForReply,
							messageId,
							senderEmail: senderEmailToUse,
							recipientEmail: normalizedRecipient,
							recipientEmails: normalizedRecipient ? [normalizedRecipient] : null,
							subject: subjectValue,
							body: bodyText,
							userId,
							workspaceId
						});
						if (draftResult.created) {
							await createDraftNotification({
								workspaceId,
								issueId: issueIdForReply,
								issueName,
								emailDraftId: draftResult.draftId,
								messageId,
								userId
							});
						}
					} catch (err) {
						await insertIngestionLog({
							userId,
							source: 'gmail-draft-error',
							detail: JSON.stringify({
								issue_id: issueIdForReply,
								message_id: messageId,
								error: err?.message ?? 'draft insert failed'
							})
						});
						await logAgentErrorForGmail({
							workspaceId,
							issueId: issueIdForReply,
							userId,
							action: 'draft_reply',
							error: err?.message ?? 'draft insert failed',
							messageId,
							runId,
							step: i
						});
					}
					draftedIssueId = issueIdForReply;
					issuedAction = true;
					result = { ok: true };
				}

				if (name === 'done') {
					doneCalled = true;
					issuedAction = true;
					result = { ok: true };
				}
			} catch (err) {
				await insertIngestionLog({
					userId,
					source: 'gmail-agent-error',
					detail: JSON.stringify({
						action: name,
						error: err?.message ?? 'unknown',
						message_id: typeof args.message_id === 'string' ? args.message_id : null,
						run_id: runId,
						step: i
					})
				});
				await logAgentErrorForGmail({
					workspaceId,
					issueId: lastSubissueId ?? linkedIssueId ?? createdIssueId ?? rootIssueId ?? null,
					userId,
					action: name,
					error: err?.message ?? 'unknown',
					messageId: typeof args.message_id === 'string' ? args.message_id : null,
					runId,
					step: i
				});
				throw err;
			}

			messages.push({
				type: 'function_call_output',
				call_id: toolCall.call_id ?? toolCall.id,
				output: JSON.stringify(result)
			});
		}

		if (!issuedAction) {
			messages.push({
				role: 'assistant',
				content:
					'You must create an issue (if needed), create a subissue, optionally draft, then link the thread, then done.'
			});
			continue;
		}
		if (doneCalled) {
			break;
		}
	}

	if (!threadLinked) {
		await logError(userId, 'LLM did not link thread to issue.');
	}

	if (!linkedIssueId) {
		const fallbackIssueId = lastSubissueId ?? createdIssueId;
		if (fallbackIssueId) {
			await linkThreadToIssue({ threadId, issueId: fallbackIssueId });
			linkedIssueId = fallbackIssueId;
		} else {
			await logError(userId, 'LLM did not create/link issue; generating title directly.');
			const llmTitle = await generateIssueTitle({
				subject,
				body,
				senderEmail,
				unitId,
				workspaceId
			});
			const fallbackTitle = llmTitle || 'Maintenance Issue';
			linkedIssueId = await createIssueForGmail({
				name: fallbackTitle,
				unitId,
				workspaceId,
				assigneeId: resolveAssigneeId({
					requestedAssigneeId: null,
					fallbackAssigneeId: workspaceAdminId,
					eligibleAssignees
				})
			});
			createdIssueId = linkedIssueId;
			await linkThreadToIssue({ threadId, issueId: linkedIssueId });
		}
	}

	return { issueId: linkedIssueId };
};

const handleGmailAgent = async ({ payload }) => {
	const subject = typeof payload?.subject === 'string' ? payload.subject : '';
	const body = typeof payload?.body === 'string' ? payload.body : '';
	const senderEmail = typeof payload?.sender_email === 'string' ? payload.sender_email : '';
	const workspaceId = typeof payload?.workspace_id === 'string' ? payload.workspace_id : '';
	const threadId = typeof payload?.thread_id === 'string' ? payload.thread_id : '';
	const userId = typeof payload?.user_id === 'string' ? payload.user_id : '';

	if (!body || !senderEmail || !workspaceId || !threadId || !userId) {
		return json({ error: 'Missing required gmail payload fields' }, { status: 400 });
	}

	const policyText = typeof payload?.policy_text === 'string' ? payload.policy_text : '';
	const workspaceUnits = Array.isArray(payload?.workspace_units) ? payload.workspace_units : [];
	const relatedIssues = Array.isArray(payload?.related_issues) ? payload.related_issues : [];

	const result = await runGmailIssueAgent({
		subject,
		body,
		senderEmail,
		unitId: typeof payload?.unit_id === 'string' ? payload.unit_id : null,
		unitName: typeof payload?.unit_name === 'string' ? payload.unit_name : null,
		workspaceId,
		propertyName: typeof payload?.property_name === 'string' ? payload.property_name : null,
		threadId,
		userId,
		policyText,
		tenantName: typeof payload?.tenant_name === 'string' ? payload.tenant_name : null,
		tenantEmail: typeof payload?.tenant_email === 'string' ? payload.tenant_email : null,
		userName: typeof payload?.user_name === 'string' ? payload.user_name : null,
		defaultSenderEmail:
			typeof payload?.default_sender_email === 'string' ? payload.default_sender_email : null,
		replyMessageId: typeof payload?.reply_message_id === 'string' ? payload.reply_message_id : null,
		rootIssueId: typeof payload?.root_issue_id === 'string' ? payload.root_issue_id : null,
		threadIssueId: typeof payload?.thread_issue_id === 'string' ? payload.thread_issue_id : null,
		relatedIssues,
		workspaceUnits
	});

	return json({ issueId: result?.issueId ?? null });
};

const isAgentSecretValid = (request) => {
	if (!AGENT_WEBHOOK_SECRET) return false;
	const provided = request.headers.get(agentSecretHeader) ?? '';
	return provided === AGENT_WEBHOOK_SECRET;
};

export const POST = async ({ request, locals }) => {
	if (!SUPABASE_SERVICE_ROLE_KEY)
		return json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 });
	if (!PUBLIC_SUPABASE_URL) return json({ error: 'Missing PUBLIC_SUPABASE_URL' }, { status: 500 });

	if (!locals?.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const payload = await request.json().catch(() => null);
	const body = {
		source: typeof payload?.source === 'string' ? payload.source : 'comment',
		...payload,
		user_id: payload?.user_id ?? locals.user.id
	};

	const response = await fetch(`${PUBLIC_SUPABASE_URL}/functions/v1/agent`, {
		method: 'POST',
		headers: {
			apikey: SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (!response.ok) {
		return json({ error: await response.text() }, { status: response.status });
	}

	const data = await response.json().catch(() => ({}));
	return json(data, { status: 200 });
};
