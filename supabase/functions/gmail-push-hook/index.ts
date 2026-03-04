import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const openaiApiKey = Deno.env.get('OPENAI_API_KEY');

if (!supabaseUrl || !supabaseServiceKey) {
	throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

if (!openaiApiKey) {
	throw new Error('Missing OPENAI_API_KEY');
}

const openaiModel = 'gpt-5-mini-2025-08-07';

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
	auth: { persistSession: false, autoRefreshToken: false }
});

const decodeBase64Url = (input: string) => {
	const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
	const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
	const binary = atob(normalized + pad);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder('utf-8').decode(bytes);
};

const decodeQuotedPrintable = (input: string) => {
	const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
	return withoutSoftBreaks.replace(/=([0-9A-F]{2})/gi, (_match, hex) =>
		String.fromCharCode(parseInt(hex, 16))
	);
};

const normalizeQuotedPrintable = (input: string) =>
	/=\r?\n|=[0-9A-F]{2}/i.test(input) ? decodeQuotedPrintable(input) : input;

const stripHtml = (input: string) =>
	input
		.replace(/<br\s*\/?\s*>/gi, '\n')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();

const trimQuotedReply = (input: string) => {
	const markerMatch = input.split(/\nOn .*wrote:\n/i);
	return markerMatch[0].trim();
};

const extractHeaders = (headers: Array<{ name: string; value: string }>) => {
	const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
	const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
	return { subject, from };
};

const extractEmail = (fromValue: string) => {
	const match = fromValue.match(/<([^>]+)>/);
	if (match?.[1]) return match[1].trim();
	return fromValue.trim();
};

const normalizeEmail = (value: string) => value.trim().toLowerCase();

const findBodyPart = (payload: any, mimeType: string): string | null => {
	if (!payload) return null;
	if (payload.mimeType === mimeType && payload.body?.data) {
		return payload.body.data;
	}
	if (payload.parts) {
		for (const part of payload.parts) {
			const found = findBodyPart(part, mimeType);
			if (found) return found;
		}
	}
	return null;
};

const fetchMessage = async (accessToken: string, messageId: string) => {
	const response = await fetch(
		`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);
	if (response.ok) {
		return response.json();
	}
	if (response.status === 404) {
		return null;
	}
	throw new Error(await response.text());
};

const fetchHistory = async (accessToken: string, historyId: string) => {
	const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
	url.searchParams.set('startHistoryId', historyId);
	url.searchParams.set('historyTypes', 'messageAdded');

	const response = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${accessToken}` }
	});

	if (!response.ok) {
		const detail = await response.text();
		const error = new Error(detail);
		// @ts-ignore
		error.status = response.status;
		throw error;
	}

	return response.json();
};

const fetchProfile = async (accessToken: string) => {
	const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	if (!response.ok) {
		throw new Error(await response.text());
	}
	return response.json();
};

const insertIngestionLog = async ({
	userId,
	source,
	detail
}: {
	userId: string;
	source: string;
	detail: string;
}) => {
	const trimmed = detail.slice(0, 4000);
	const { error } = await supabase
		.schema('errors')
		.from('ingestion_errors')
		.insert({ user_id: userId, source, detail: trimmed });
	if (error) {
		console.error('gmail-push-hook log insert failed', error);
	}
};

const logError = async (userId: string, detail: string) => {
	await insertIngestionLog({ userId, source: 'gmail-push', detail });
};

const logLlmOutput = async (userId: string, payload: unknown, runId: string, step: number) => {
	try {
		await insertIngestionLog({
			userId,
			source: 'gmail-llm',
			detail: JSON.stringify({ run_id: runId, step, output: payload })
		});
	} catch (err) {
		console.error('gmail-push-hook llm log failed', err);
	}
};

const listOpenIssues = async (unitId: string) => {
	const { data } = await supabase
		.from('issues')
		.select('id, name, status, parent_id, updated_at')
		.eq('unit_id', unitId)
		.in('status', ['todo', 'in_progress'])
		.order('updated_at', { ascending: false })
		.limit(25);
	return data ?? [];
};

const listVendors = async (workspaceId: string) => {
	const { data } = await supabase
		.from('people')
		.select('id, name, email, trade')
		.eq('workspace_id', workspaceId)
		.eq('role', 'vendor')
		.order('name', { ascending: true });
	return data ?? [];
};

const createIssue = async ({
	name,
	unitId,
	workspaceId
}: {
	name: string;
	unitId: string;
	workspaceId: string;
}) => {
	const { data, error } = await supabase
		.from('issues')
		.insert({
			name,
			unit_id: unitId,
			workspace_id: workspaceId,
			status: 'todo'
		})
		.select('id')
		.single();
	if (error || !data?.id) {
		throw new Error(error?.message ?? 'Issue insert failed');
	}
	return data.id as string;
};

const createSubissue = async ({
	parentIssueId,
	name,
	unitId,
	workspaceId,
	status,
	reasoning
}: {
	parentIssueId: string;
	name: string;
	unitId: string;
	workspaceId: string;
	status: string;
	reasoning: string | null;
}) => {
	const { data, error } = await supabase
		.from('issues')
		.insert({
			parent_id: parentIssueId,
			name,
			unit_id: unitId,
			workspace_id: workspaceId,
			status,
			reasoning
		})
		.select('id')
		.single();
	if (error || !data?.id) {
		throw new Error(error?.message ?? 'Subissue insert failed');
	}
	return data.id as string;
};

const upsertEmailDraft = async ({
	issueId,
	messageId,
	senderEmail,
	recipientEmail,
	subject,
	body,
	userId
}: {
	issueId: string;
	messageId: string | null;
	senderEmail: string;
	recipientEmail: string | null;
	subject: string;
	body: string;
	userId: string;
}) => {
	const payload = {
		issue_id: issueId,
		message_id: messageId,
		sender_email: senderEmail,
		recipient_email: recipientEmail,
		subject,
		body,
		updated_at: new Date().toISOString()
	};

	let error = null;
	if (messageId) {
		const result = await supabase
			.from('email_drafts')
			.upsert(payload, { onConflict: 'message_id' });
		error = result.error;
	} else {
		const { data: existingDraft } = await supabase
			.from('email_drafts')
			.select('id')
			.eq('issue_id', issueId)
			.is('message_id', null)
			.maybeSingle();
		if (existingDraft?.id) {
			const result = await supabase.from('email_drafts').update(payload).eq('id', existingDraft.id);
			error = result.error;
		} else {
			const result = await supabase.from('email_drafts').insert(payload);
			error = result.error;
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
	await insertIngestionLog({
		userId,
		source: 'gmail-draft',
		detail: JSON.stringify({ issue_id: issueId, message_id: messageId })
	});
};

const linkThreadToIssue = async ({ threadId, issueId }: { threadId: string; issueId: string }) => {
	const { data, error } = await supabase
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

const generateIssueTitle = async ({
	subject,
	body,
	senderEmail,
	unitId,
	workspaceId
}: {
	subject: string;
	body: string;
	senderEmail: string;
	unitId: string;
	workspaceId: string;
}) => {
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
			Authorization: `Bearer ${openaiApiKey}`,
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

const runIssueAgent = async ({
	subject,
	body,
	senderEmail,
	unitId,
	workspaceId,
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
	relatedIssues
}: {
	subject: string;
	body: string;
	senderEmail: string;
	unitId: string;
	workspaceId: string;
	threadId: string;
	userId: string;
	policyText: string;
	tenantName: string | null;
	tenantEmail: string | null;
	userName: string | null;
	defaultSenderEmail: string | null;
	replyMessageId: string | null;
	rootIssueId?: string | null;
	threadIssueId?: string | null;
	relatedIssues?: Array<{
		id: string;
		name: string | null;
		status: string | null;
		parent_id: string | null;
	}>;
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

Rules:
- Use tools only.
- Issue title: 2-5 words, Title Case, no location or unit/building names.
- Status must be 'todo' when creating a new issue.
- Subissue title format:
  - Triage {Issue Title} (${tenantName ?? 'Tenant'})
  - Schedule {Vendor Type} for {Issue Title}
- Subissue parent rules: Triage and Schedule subissues must use root_issue_id as parent. Never use thread_issue_id as the parent for Schedule.
- Use the workspace_policy to decide triage vs schedule vendor. If policy is empty or unclear, triage unless it matches an emergency.
- Drafts: Always write from the property manager POV (the user). Never write from the tenant POV.
- Drafts: For tenant replies, address the tenant by tenant_name only. Never infer a name from the email address.
- Drafts: End with the user_name as the signature. Never use an email address as the signature.
- Drafts: Never use default_sender_email in the email body.
- Drafts: When triaging, draft a short, friendly reply acknowledging the issue and asking one clarifying question about emergency indicators if relevant.
- Drafts: When scheduling, draft a short, direct vendor email requesting availability and permission to access.
- Drafts: Use draft_reply for replies and draft_email for new outbound emails.
- Drafts: For Schedule subissues, the draft recipient must be a vendor email or null; never send to sender_email.
- Drafts: sender_email should not be provided by the agent. The system will use default_sender_email.
- Drafts: When provided, pass recipient_email as a plain email address (no display name).
- root_issue_id: When present, you must not call create_issue. Reuse existing subissues when possible.
- Drafts: Use the subissue id for issue_id. For replies, use latest_message_id for message_id. For vendor scheduling drafts, use draft_email for new outreach and draft_reply for replies; include message_id only when replying in an existing vendor thread, otherwise omit it entirely (do not send empty string).
- Linking: Call link_thread_to_issue exactly once and only after issue/subissue creation. This is required.
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
				unit_id: { type: 'string' },
				workspace_id: { type: 'string' }
			},
			required: ['title', 'unit_id', 'workspace_id']
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
				reasoning: { type: 'string' }
			},
			required: ['parent_issue_id', 'title', 'status', 'reasoning']
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
	const messages: Array<any> = [
		{ role: 'system', content: system },
		{
			role: 'user',
			content: JSON.stringify({
				subject,
				body,
				sender_email: senderEmail,
				unit_id: unitId,
				workspace_id: workspaceId,
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
				default_sender_email: defaultSenderEmail
			})
		}
	];

	const runId = crypto.randomUUID();
	let linkedIssueId: string | null = null;
	let createdIssueId: string | null = null;
	let lastSubissueId: string | null = null;
	let lastSubissueTitle: string | null = null;
	let draftedIssueId: string | null = null;
	let threadLinked = false;
	const issueNameCache = new Map<string, string>();

	for (let i = 0; i < 6; i += 1) {
		const response = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${openaiApiKey}`,
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
			(item: { type?: string }) => item.type === 'tool_call' || item.type === 'function_call'
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
			let result: Record<string, unknown> = {};

			if (name === 'create_issue') {
				const title = typeof args.title === 'string' ? args.title.trim() : '';
				const unit = typeof args.unit_id === 'string' ? args.unit_id : unitId;
				const workspace = typeof args.workspace_id === 'string' ? args.workspace_id : workspaceId;
				if (!title) {
					throw new Error('create_issue missing title');
				}
				const issueId = await createIssue({ name: title, unitId: unit, workspaceId: workspace });
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
					const { data: existingThread } = await supabase
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
				result = { ok: true };
			}

			if (name === 'create_subissue') {
				const title = typeof args.title === 'string' ? args.title.trim() : '';
				const statusValue = typeof args.status === 'string' ? args.status : 'todo';
				const status = ['todo', 'in_progress', 'done'].includes(statusValue) ? statusValue : 'todo';
				const reasoning = typeof args.reasoning === 'string' ? args.reasoning : '';
				const requestedParent =
					typeof args.parent_issue_id === 'string' ? args.parent_issue_id : null;
				const parentIssueId = requestedParent ?? linkedIssueId ?? createdIssueId;
				if (!title || !parentIssueId) {
					throw new Error('create_subissue missing title or parent_issue_id');
				}
				const subissueId = await createSubissue({
					parentIssueId,
					name: title,
					unitId,
					workspaceId,
					status,
					reasoning
				});
				lastSubissueId = subissueId;
				lastSubissueTitle = title;
				issuedAction = true;
				result = { subissue_id: subissueId };
			}

			if (name === 'draft_reply') {
				const issue = typeof args.issue_id === 'string' ? args.issue_id : lastSubissueId;
				const messageId = typeof args.message_id === 'string' ? args.message_id.trim() : '';
				const subject = typeof args.subject === 'string' ? args.subject : '';
				const bodyText = typeof args.body === 'string' ? args.body : '';
				const senderEmailToUse = defaultSenderEmail ? normalizeEmail(defaultSenderEmail) : '';
				if (!issue || !messageId || !subject || !bodyText) {
					throw new Error('draft_reply missing required fields');
				}
				if (!senderEmailToUse) {
					throw new Error('draft_reply missing default_sender_email');
				}

				const { data: messageRow } = await supabase
					.from('messages')
					.select('id, thread_id')
					.eq('id', messageId)
					.maybeSingle();
				if (!messageRow?.thread_id) {
					throw new Error('draft_reply message not found');
				}

				const { data: threadRow } = await supabase
					.from('threads')
					.select('id, issue_id, participant_type, participant_id, tenant_id')
					.eq('id', messageRow.thread_id)
					.maybeSingle();
				if (!threadRow?.id) {
					throw new Error('draft_reply thread not found');
				}
				const issueIdForReply = threadRow.issue_id ?? issue;

				let recipientEmail = '';
				if (threadRow.participant_type === 'tenant') {
					const tenantId = threadRow.tenant_id ?? threadRow.participant_id;
					if (!tenantId) {
						throw new Error('draft_reply missing tenant_id');
					}
					const { data: tenantRow } = await supabase
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
					const { data: vendorRow } = await supabase
						.from('people')
						.select('email')
						.eq('id', vendorId)
						.eq('role', 'vendor')
						.maybeSingle();
					recipientEmail = vendorRow?.email ?? '';
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
					await upsertEmailDraft({
						issueId: issueIdForReply,
						messageId,
						senderEmail: senderEmailToUse,
						recipientEmail: normalizedRecipient,
						subject,
						body: bodyText,
						userId
					});
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
				}
				draftedIssueId = issueIdForReply;
				issuedAction = true;
				result = { ok: true };
			}

			if (name === 'draft_email') {
				const issue = typeof args.issue_id === 'string' ? args.issue_id : lastSubissueId;
				const senderEmailToUse = defaultSenderEmail ? normalizeEmail(defaultSenderEmail) : '';
				let recipient =
					typeof args.recipient_email === 'string'
						? args.recipient_email
						: typeof args.recipient === 'string'
							? args.recipient
							: '';
				const subject = typeof args.subject === 'string' ? args.subject : '';
				const bodyText = typeof args.body === 'string' ? args.body : '';
				if (!issue || !subject || !bodyText) {
					throw new Error('draft_email missing required fields');
				}
				if (!senderEmailToUse) {
					throw new Error('draft_email missing default_sender_email');
				}

				let issueName = issueNameCache.get(issue) ?? '';
				if (!issueName) {
					const { data: issueRow } = await supabase
						.from('issues')
						.select('name')
						.eq('id', issue)
						.maybeSingle();
					issueName = issueRow?.name ?? '';
					if (issueName) issueNameCache.set(issue, issueName);
				}
				const isScheduleSubissue = issueName.startsWith('Schedule ');
				const rawMessageId = typeof args.message_id === 'string' ? args.message_id.trim() : '';
				const messageId = rawMessageId || null;
				let normalizedRecipient = recipient ? normalizeEmail(extractEmail(recipient)) : null;
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
				if (!normalizedRecipient && !isScheduleSubissue) {
					throw new Error('draft_email missing recipient_email');
				}
				try {
					await upsertEmailDraft({
						issueId: issue,
						messageId,
						senderEmail: senderEmailToUse,
						recipientEmail: normalizedRecipient,
						subject,
						body: bodyText,
						userId
					});
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
				}
				draftedIssueId = issue;
				issuedAction = true;
				result = { ok: true };
			}

			if (name === 'done') {
				doneCalled = true;
				issuedAction = true;
				result = { ok: true };
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

	// All LLM outputs logged per step above.

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
			linkedIssueId = await createIssue({ name: fallbackTitle, unitId, workspaceId });
			createdIssueId = linkedIssueId;
			await linkThreadToIssue({ threadId, issueId: linkedIssueId });
		}
	}

	return { issueId: linkedIssueId };
};

const processMessage = async ({
	connection,
	accessToken,
	message
}: {
	connection: any;
	accessToken: string;
	message: any;
}) => {
	const pmEmail = connection.email ? normalizeEmail(connection.email) : null;
	const { subject: messageSubject, from: messageFrom } = extractHeaders(
		message.payload?.headers ?? []
	);
	const senderEmail = normalizeEmail(extractEmail(messageFrom));
	if (pmEmail && senderEmail === pmEmail) {
		await insertIngestionLog({
			userId: connection.user_id,
			source: 'gmail-push',
			detail: JSON.stringify({
				phase: 'skip-self',
				sender_email: senderEmail,
				connection_email: pmEmail
			})
		});
		return;
	}

	const { data: existingMessage } = await supabase
		.from('messages')
		.select('id')
		.eq('external_id', message.id)
		.maybeSingle();

	if (existingMessage?.id) {
		await insertIngestionLog({
			userId: connection.user_id,
			source: 'gmail-push',
			detail: JSON.stringify({
				phase: 'skip-duplicate-message',
				external_id: message.id
			})
		});
		return;
	}

	const plain = findBodyPart(message.payload, 'text/plain');
	const html = plain ? null : findBodyPart(message.payload, 'text/html');
	const rawBody = plain ? decodeBase64Url(plain) : html ? decodeBase64Url(html) : '';
	const decodedBody = normalizeQuotedPrintable(rawBody);
	const normalizedBody = html ? stripHtml(decodedBody) : decodedBody.trim();
	const cleanedBody = trimQuotedReply(normalizedBody);

	const { data: tenant } = await supabase
		.from('tenants')
		.select('id, unit_id, email, name')
		.ilike('email', senderEmail)
		.maybeSingle();

	if (!tenant?.id || !tenant.unit_id) {
		await logError(connection.user_id, `No tenant match for ${senderEmail}`);
		return;
	}

	const { data: unitRow } = await supabase
		.from('units')
		.select('id, name, property_id')
		.eq('id', tenant.unit_id)
		.maybeSingle();

	if (!unitRow?.id || !unitRow.property_id) {
		await logError(connection.user_id, `Unit lookup failed for tenant ${tenant.id}`);
		return;
	}

	const { data: propertyRow } = await supabase
		.from('properties')
		.select('id, workspace_id')
		.eq('id', unitRow.property_id)
		.maybeSingle();

	if (!propertyRow?.workspace_id) {
		await logError(connection.user_id, `Workspace lookup failed for unit ${unitRow.id}`);
		return;
	}

	const threadExternalId = message.threadId ?? null;
	let threadRow = null;

	if (threadExternalId) {
		const { error: insertError } = await supabase.from('threads').upsert(
			{
				tenant_id: tenant.id,
				participant_type: 'tenant',
				participant_id: tenant.id,
				name: messageSubject || 'Gmail thread',
				external_id: threadExternalId,
				connection_id: connection.id,
				workspace_id: propertyRow.workspace_id
			},
			{ onConflict: 'external_id', ignoreDuplicates: true }
		);
		if (insertError) {
			await logError(
				connection.user_id,
				`Thread upsert failed: ${insertError?.message ?? 'unknown'}`
			);
			return;
		}
		const { data: existingThread } = await supabase
			.from('threads')
			.select('id, issue_id')
			.eq('external_id', threadExternalId)
			.maybeSingle();
		threadRow = existingThread ?? null;
	}

	if (!threadRow?.id) {
		const { data: createdThread, error: threadError } = await supabase
			.from('threads')
			.insert({
				tenant_id: tenant.id,
				participant_type: 'tenant',
				participant_id: tenant.id,
				issue_id: null,
				name: messageSubject || 'Gmail thread',
				external_id: threadExternalId,
				connection_id: connection.id,
				workspace_id: propertyRow.workspace_id
			})
			.select('id, issue_id')
			.single();

		if (threadError || !createdThread?.id) {
			await logError(
				connection.user_id,
				`Thread insert failed: ${threadError?.message ?? 'unknown'}`
			);
			return;
		}
		threadRow = createdThread;
	}

	const lockCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
	const lockTime = new Date().toISOString();
	const { data: lockRow } = await supabase
		.from('threads')
		.update({ processing_at: lockTime })
		.eq('id', threadRow.id)
		.is('processing_at', null)
		.select('id')
		.maybeSingle();
	let lockAcquired = Boolean(lockRow?.id);
	if (!lockAcquired) {
		const { data: staleLockRow } = await supabase
			.from('threads')
			.update({ processing_at: lockTime })
			.eq('id', threadRow.id)
			.lt('processing_at', lockCutoff)
			.select('id')
			.maybeSingle();
		lockAcquired = Boolean(staleLockRow?.id);
	}
	if (!lockAcquired) {
		await insertIngestionLog({
			userId: connection.user_id,
			source: 'gmail-push',
			detail: JSON.stringify({
				phase: 'lock-skip',
				thread_id: threadRow.id,
				external_thread_id: threadExternalId
			})
		});
		return;
	}

	try {
		const internalDate = Number(message.internalDate ?? 0);
		const { data: inboundMessage, error: inboundInsertError } = await supabase
			.from('messages')
			.insert({
				thread_id: threadRow.id,
				external_id: message.id,
				message: cleanedBody,
				sender: 'tenant',
				subject: messageSubject,
				timestamp: new Date(internalDate || Date.now()).toISOString(),
				channel: 'gmail',
				direction: 'inbound',
				delivery_status: 'received',
				connection_id: connection.id,
				issue_id: threadRow.issue_id ?? null,
				thread_external_id: threadExternalId
			})
			.select('id')
			.maybeSingle();

		let inboundMessageId = inboundMessage?.id ?? null;
		if (inboundInsertError) {
			if (inboundInsertError.code === '23505') {
				const { data: existingMessage } = await supabase
					.from('messages')
					.select('id')
					.eq('external_id', message.id)
					.maybeSingle();
				inboundMessageId = existingMessage?.id ?? null;
				if (!inboundMessageId) {
					return;
				}
			} else {
				await logError(connection.user_id, `Inbound insert failed: ${inboundInsertError.message}`);
				return;
			}
		}

		const { data: refreshedThread } = await supabase
			.from('threads')
			.select('issue_id')
			.eq('id', threadRow.id)
			.maybeSingle();

		let issueId = refreshedThread?.issue_id ?? threadRow.issue_id ?? null;
		let rootIssueIdForAgent = issueId;
		let relatedIssues = [];
		if (issueId) {
			const { data: issueRow } = await supabase
				.from('issues')
				.select('id, name, status, parent_id')
				.eq('id', issueId)
				.maybeSingle();
			rootIssueIdForAgent = issueRow?.parent_id ?? issueRow?.id ?? issueId;
			if (rootIssueIdForAgent) {
				const { data: related } = await supabase
					.from('issues')
					.select('id, name, status, parent_id')
					.or(`id.eq.${rootIssueIdForAgent},parent_id.eq.${rootIssueIdForAgent}`);
				relatedIssues = related ?? [];
			}
		}

		const { data: policyRow } = await supabase
			.from('workspace_policies')
			.select('policy_text')
			.eq('workspace_id', propertyRow.workspace_id)
			.maybeSingle();
		const policyText = policyRow?.policy_text ?? '';
		const { data: userProfile } = await supabase
			.from('users')
			.select('name')
			.eq('id', connection.user_id)
			.maybeSingle();
		const userName = userProfile?.name ?? 'Bedrock';
		const created = await runIssueAgent({
			subject: messageSubject,
			body: cleanedBody,
			senderEmail,
			unitId: unitRow.id,
			workspaceId: propertyRow.workspace_id,
			threadId: threadRow.id,
			userId: connection.user_id,
			policyText,
			tenantName: tenant.name ?? null,
			tenantEmail: tenant.email ?? null,
			userName,
			defaultSenderEmail: connection.email ?? null,
			replyMessageId: inboundMessageId,
			rootIssueId: rootIssueIdForAgent,
			threadIssueId: issueId,
			relatedIssues
		});
		issueId = created.issueId ?? issueId;

		if (issueId) {
			await supabase.from('threads').update({ issue_id: issueId }).eq('id', threadRow.id);

			await supabase.from('messages').update({ issue_id: issueId }).eq('thread_id', threadRow.id);
		}
	} finally {
		await supabase.from('threads').update({ processing_at: null }).eq('id', threadRow.id);
	}
};

serve(async (req) => {
	try {
		if (req.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 });
		}

		const body = await req.json().catch(() => null);
		const data = body?.message?.data;
		if (!data) {
			return new Response('Missing Pub/Sub message', { status: 400 });
		}

		const decoded = decodeBase64Url(data);
		const payload = JSON.parse(decoded);
		const emailAddress = payload.emailAddress;
		const historyId = payload.historyId;
		const normalizedEmail = emailAddress ? normalizeEmail(emailAddress) : null;

		if (!normalizedEmail || !historyId) {
			return new Response('Invalid payload', { status: 400 });
		}

		const { data: connection } = await supabase
			.from('gmail_connections')
			.select('*')
			.eq('email', normalizedEmail)
			.maybeSingle();

		if (!connection) {
			return new Response(JSON.stringify({ status: 'ignored' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		await insertIngestionLog({
			userId: connection.user_id,
			source: 'gmail-push',
			detail: JSON.stringify({
				phase: 'invoke',
				payload_email: normalizedEmail,
				connection_email: connection.email,
				history_id: historyId
			})
		});

		if (connection.mode === 'write') {
			return new Response(JSON.stringify({ status: 'skip' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		let accessToken = connection.access_token;
		const expiresAt = new Date(connection.expires_at).getTime();
		const refreshNeeded = Number.isNaN(expiresAt) || expiresAt - Date.now() < 120000;

		if (refreshNeeded) {
			const refreshBody = new URLSearchParams({
				client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
				client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
				refresh_token: connection.refresh_token,
				grant_type: 'refresh_token'
			});

			const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: refreshBody
			});

			if (!refreshResponse.ok) {
				const detail = await refreshResponse.text();
				console.error('gmail-push-hook refresh failed', detail);
				if (detail.includes('invalid_grant')) {
					await supabase
						.from('gmail_connections')
						.update({
							access_token: null,
							refresh_token: null,
							expires_at: new Date(0).toISOString(),
							mode: 'write',
							updated_at: new Date().toISOString()
						})
						.eq('id', connection.id);
					await logError(
						connection.user_id,
						`Gmail token revoked for ${connection.email}. Please reconnect.`
					);
					return new Response('Token revoked', { status: 200 });
				}
				return new Response(detail, { status: 500 });
			}

			const refreshed = await refreshResponse.json();
			accessToken = refreshed.access_token;
			const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
			await supabase
				.from('gmail_connections')
				.update({
					access_token: accessToken,
					expires_at: newExpiresAt,
					updated_at: new Date().toISOString()
				})
				.eq('id', connection.id);
		}

		const { data: state } = await supabase
			.from('email_ingestion_state')
			.select('last_history_id')
			.eq('connection_id', connection.id)
			.maybeSingle();

		let storedHistoryId = state?.last_history_id ?? null;
		if (storedHistoryId && storedHistoryId.length >= 13) {
			storedHistoryId = null;
		}

		let historyResponse;
		try {
			historyResponse = await fetchHistory(accessToken, storedHistoryId ?? historyId);
		} catch (err) {
			const status = err && typeof err === 'object' ? err.status : null;
			if (status === 404) {
				const profile = await fetchProfile(accessToken);
				await supabase.from('email_ingestion_state').upsert({
					user_id: connection.user_id,
					connection_id: connection.id,
					last_history_id: String(profile.historyId),
					updated_at: new Date().toISOString()
				});
				return new Response(JSON.stringify({ status: 'reset' }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			console.error('gmail-push-hook history error', err);
			throw err;
		}

		const historyItems = historyResponse.history ?? [];
		const messageIds = new Set<string>();
		for (const item of historyItems) {
			for (const msg of item.messagesAdded ?? []) {
				if (msg.message?.id) {
					messageIds.add(msg.message.id);
				}
			}
		}

		if (!messageIds.size) {
			await insertIngestionLog({
				userId: connection.user_id,
				source: 'gmail-push',
				detail: JSON.stringify({
					phase: 'history-empty',
					history_id: historyId,
					stored_history_id: storedHistoryId
				})
			});
		}

		for (const messageId of messageIds) {
			const message = await fetchMessage(accessToken, messageId);
			if (!message) {
				continue;
			}
			await processMessage({ connection, accessToken, message });
		}

		const newHistoryId = historyResponse.historyId ?? historyId;
		await supabase.from('email_ingestion_state').upsert({
			user_id: connection.user_id,
			connection_id: connection.id,
			last_history_id: String(newHistoryId),
			updated_at: new Date().toISOString()
		});

		return new Response(JSON.stringify({ status: 'ok' }), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (err) {
		console.error('gmail-push-hook error', err);
		return new Response('Internal error', { status: 500 });
	}
});
