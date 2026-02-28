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
		.select('id, name, status, updated_at')
		.eq('unit_id', unitId)
		.in('status', ['todo', 'in_progress'])
		.order('updated_at', { ascending: false })
		.limit(25);
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

const linkThreadToIssue = async ({ threadId, issueId }: { threadId: string; issueId: string }) => {
	const { data, error } = await supabase
		.from('threads')
		.update({ issue_id: issueId, updated_at: new Date().toISOString() })
		.eq('id', threadId)
		.is('issue_id', null)
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
	tenantName
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
}) => {
	const system = `You are Bedrock, an assistant for property management.
Your job is to link this email thread to an existing open issue or create a new issue, then create one subissue for the next step.

Process (required):
1) Review the provided open_issues list.
2) If a clear match exists, call link_thread_to_issue with that issue_id.
3) If no clear match, call create_issue with a concise title, then call link_thread_to_issue.
4) Create exactly one subissue using create_subissue with the root issue id.

Rules:
- Use tools only.
- Issue title: 2-5 words, Title Case, no location or unit/building names.
- Status must be 'todo' when creating a new issue.
- Subissue title format:
  - Triage {Issue Title} (${tenantName ?? 'Tenant'})
  - Schedule {Vendor Type} for {Issue Title}
- Use the workspace_policy to decide triage vs schedule vendor.
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

	const tools = [createIssueTool, linkThreadTool, createSubissueTool, doneTool];

	const openIssues = await listOpenIssues(unitId);
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
				open_issues: openIssues,
				workspace_policy: policyText
			})
		}
	];

	const runId = crypto.randomUUID();
	let linkedIssueId: string | null = null;
	let createdIssueId: string | null = null;

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
				content:
					'You must call create_issue or link_thread_to_issue. Use create_issue if no clear match.'
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
				const linked = await linkThreadToIssue({ threadId, issueId });
				if (!linked) {
					await supabase.from('issues').delete().eq('id', issueId);
					const { data: existingThread } = await supabase
						.from('threads')
						.select('issue_id')
						.eq('id', threadId)
						.maybeSingle();
					linkedIssueId = existingThread?.issue_id ?? null;
					result = { issue_id: linkedIssueId, duplicate: true };
					issuedAction = true;
					continue;
				}
				linkedIssueId = issueId;
				createdIssueId = issueId;
				issuedAction = true;
				result = { issue_id: issueId };
			}

			if (name === 'link_thread_to_issue') {
				const thread = typeof args.thread_id === 'string' ? args.thread_id : threadId;
				const issue = typeof args.issue_id === 'string' ? args.issue_id : linkedIssueId;
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
				issuedAction = true;
				result = { ok: true };
			}

			if (name === 'create_subissue') {
				const title = typeof args.title === 'string' ? args.title.trim() : '';
				const status = typeof args.status === 'string' ? args.status : 'todo';
				const reasoning = typeof args.reasoning === 'string' ? args.reasoning : '';
				const parentIssueId =
					typeof args.parent_issue_id === 'string'
						? args.parent_issue_id
						: (linkedIssueId ?? createdIssueId);
				if (!title || !parentIssueId) {
					throw new Error('create_subissue missing title or parent_issue_id');
				}
				await createSubissue({
					parentIssueId,
					name: title,
					unitId,
					workspaceId,
					status,
					reasoning
				});
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
					'You must call create_issue or link_thread_to_issue, then create_subissue, then done.'
			});
			continue;
		}
		if (doneCalled) {
			break;
		}
	}

	// All LLM outputs logged per step above.

	if (!linkedIssueId) {
		await logError(userId, 'LLM did not create/link issue; generating title directly.');
		const llmTitle = await generateIssueTitle({ subject, body, senderEmail, unitId, workspaceId });
		const fallbackTitle = llmTitle || 'Maintenance Issue';
		linkedIssueId = await createIssue({ name: fallbackTitle, unitId, workspaceId });
		createdIssueId = linkedIssueId;
		await linkThreadToIssue({ threadId, issueId: linkedIssueId });
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
		return;
	}

	const { data: existingMessage } = await supabase
		.from('messages')
		.select('id')
		.eq('external_id', message.id)
		.maybeSingle();

	if (existingMessage?.id) {
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

	const internalDate = Number(message.internalDate ?? 0);
	const { error: inboundInsertError } = await supabase.from('messages').insert({
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
	});

	if (inboundInsertError) {
		if (inboundInsertError.code === '23505') {
			return;
		}
		await logError(connection.user_id, `Inbound insert failed: ${inboundInsertError.message}`);
		return;
	}

	const { data: refreshedThread } = await supabase
		.from('threads')
		.select('issue_id')
		.eq('id', threadRow.id)
		.maybeSingle();

	let issueId = refreshedThread?.issue_id ?? threadRow.issue_id ?? null;

	if (!issueId) {
		const { data: policyRow } = await supabase
			.from('workspace_policies')
			.select('policy_text')
			.eq('workspace_id', propertyRow.workspace_id)
			.maybeSingle();
		const policyText = policyRow?.policy_text ?? '';
		const created = await runIssueAgent({
			subject: messageSubject,
			body: cleanedBody,
			senderEmail,
			unitId: unitRow.id,
			workspaceId: propertyRow.workspace_id,
			threadId: threadRow.id,
			userId: connection.user_id,
			policyText,
			tenantName: tenant.name ?? null
		});
		issueId = created.issueId ?? null;
	}

	if (issueId) {
		await supabase.from('threads').update({ issue_id: issueId }).eq('id', threadRow.id);

		await supabase
			.from('messages')
			.update({ issue_id: issueId })
			.eq('thread_id', threadRow.id)
			.is('issue_id', null);
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
