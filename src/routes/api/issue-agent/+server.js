// @ts-nocheck
import { json } from '@sveltejs/kit';
import { OPENAI_API_KEY, SUPABASE_SERVICE_ROLE_KEY } from '$env/static/private';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const openaiModel = 'gpt-5-mini-2025-08-07';

const isUuid = (value) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

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
		.select('issue_id')
		.maybeSingle();
	if (error) {
		throw new Error(error.message);
	}
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

const runIssueAgent = async ({
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
					const unit = typeof args.unit_id === 'string' ? args.unit_id : (issue.unit_id ?? null);
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
						messageId: typeof args.message_id === 'string' ? args.message_id : null,
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

export const POST = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!OPENAI_API_KEY) return json({ error: 'Missing OPENAI_API_KEY' }, { status: 500 });
	if (!SUPABASE_SERVICE_ROLE_KEY)
		return json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 });

	const payload = await request.json().catch(() => null);
	const issueIdRaw = typeof payload?.issue_id === 'string' ? payload.issue_id : '';
	const comment = typeof payload?.comment === 'string' ? payload.comment : '';
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
		const runResult = await runIssueAgent({
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
