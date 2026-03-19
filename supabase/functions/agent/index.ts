import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const openaiApiKey = Deno.env.get('OPENAI_API_KEY');

if (!supabaseUrl || !supabaseServiceKey) {
	throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
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

const isRelevantEmail = (subject: string, body: string) => {
	const combined = `${subject || ''}\n${body || ''}`;
	return RELEVANCE_REGEX.test(combined);
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

const getHeaderValue = (headers: Array<{ name: string; value: string }>, name: string) =>
	headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const isBulkMessage = (headers: Array<{ name: string; value: string }>) => {
	const listUnsubscribe = getHeaderValue(headers, 'List-Unsubscribe');
	const listId = getHeaderValue(headers, 'List-Id');
	const precedence = getHeaderValue(headers, 'Precedence');
	const autoSubmitted = getHeaderValue(headers, 'Auto-Submitted');
	if (listUnsubscribe || listId) return true;
	if (/\b(bulk|list|junk)\b/i.test(precedence)) return true;
	if (autoSubmitted && !/\bno\b/i.test(autoSubmitted)) return true;
	return false;
};

const RELEVANCE_REGEX =
	/\b(maintenance|repair|fix|broken|leak|leaking|water damage|flood|clog|plumb|hvac|air[- ]?cond|ac\b|heater|heating|thermostat|electrical|power outage|no power|gas leak|gas smell|smoke|alarm|mold|pest|bug|roach|bed ?bug|rat|rats|sewer|toilet|sink|shower|bath|pipe|burst|lock|key|window|door|appliance|fridge|oven|stove|dishwasher|laundry|washer|dryer|rent|payment|invoice|late fee|lease|move[- ]?in|move[- ]?out|eviction|deposit|booking|reservation|check[- ]?in|check[- ]?out|cleaning|housekeep|turnover|short[- ]?term|long[- ]?term|airbnb|vrbo|guest)\b/i;

const isUuid = (value: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

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

const logAgentError = async ({
	workspaceId,
	issueId,
	userId,
	action,
	error,
	messageId,
	runId,
	step
}: {
	workspaceId: string;
	issueId: string | null;
	userId: string;
	action: string;
	error: string;
	messageId?: string | null;
	runId?: string | null;
	step?: number | null;
}) => {
	if (!workspaceId || !userId) return;
	const { error: insertError } = await supabase.from('activity_logs').insert({
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
}: {
	workspaceId: string;
	issueId: string;
	issueName?: string | null;
	emailDraftId: string;
	messageId: string | null;
	userId: string;
}) => {
	let resolvedIssueName = issueName?.trim() ?? '';
	if (!resolvedIssueName) {
		const { data: issueRow } = await supabase
			.from('issues')
			.select('name')
			.eq('id', issueId)
			.maybeSingle();
		resolvedIssueName = issueRow?.name?.trim() ?? '';
	}

	const { data: workspaceRow } = await supabase
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
	const { error } = await supabase.from('notifications').insert({
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

const listOpenIssues = async (unitId: string | null) => {
	if (!unitId) return [];
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

const listWorkspaceUnitsForAgent = async (workspaceId: string) => {
	const { data } = await supabase
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

const getWorkspaceAdminId = async (workspaceId: string) => {
	const { data } = await supabase
		.from('workspaces')
		.select('admin_user_id')
		.eq('id', workspaceId)
		.maybeSingle();
	return data?.admin_user_id ?? null;
};

const getWorkspaceIdForUser = async (userId: string) => {
	const { data } = await supabase
		.from('people')
		.select('workspace_id')
		.eq('user_id', userId)
		.in('role', ['admin', 'member', 'owner'])
		.maybeSingle();
	if (data?.workspace_id) return data.workspace_id;
	const { data: member } = await supabase
		.from('members')
		.select('workspace_id')
		.eq('user_id', userId)
		.in('role', ['admin', 'member', 'owner'])
		.maybeSingle();
	return member?.workspace_id ?? null;
};

const getWorkspacePersonMatch = async ({
	workspaceId,
	senderEmail
}: {
	workspaceId: string;
	senderEmail: string;
}) => {
	if (!workspaceId || !senderEmail) return null;
	const { data } = await supabase
		.from('people')
		.select('id, role')
		.eq('workspace_id', workspaceId)
		.ilike('email', senderEmail)
		.in('role', ['admin', 'member', 'vendor'])
		.maybeSingle();
	return data ?? null;
};

const getPolicyMatch = async ({
	workspaceId,
	senderEmail
}: {
	workspaceId: string;
	senderEmail: string;
}) => {
	const normalized = normalizeEmail(senderEmail);
	if (!normalized) return { allow: false, block: false };
	const { data } = await supabase
		.from('workspace_policies')
		.select('type')
		.eq('workspace_id', workspaceId)
		.eq('email', normalized)
		.in('type', ['allow', 'block']);
	const types = new Set((data ?? []).map((row) => row.type));
	return { allow: types.has('allow'), block: types.has('block') };
};

const listEligibleAssignees = async (workspaceId: string): Promise<Set<string>> => {
	const { data } = await supabase
		.from('members')
		.select('user_id, role')
		.eq('workspace_id', workspaceId)
		.in('role', ['admin', 'member', 'owner']);
	const ids = (data ?? [])
		.map((row) => row.user_id)
		.filter((id): id is string => typeof id === 'string');
	return new Set(ids);
};

const listWorkspaceAssignees = async (workspaceId: string) => {
	const { data: members } = await supabase
		.from('members')
		.select('user_id, role')
		.eq('workspace_id', workspaceId)
		.in('role', ['admin', 'member', 'owner']);
	const memberIds = (members ?? [])
		.map((row) => row.user_id)
		.filter((id): id is string => typeof id === 'string');
	if (!memberIds.length) return [] as Array<{ id: string; name: string | null }>;

	const { data: users } = await supabase.from('users').select('id, name').in('id', memberIds);
	return (users ?? []).map((user) => ({
		id: typeof user.id === 'string' ? user.id : String(user.id ?? ''),
		name: typeof user.name === 'string' ? user.name : null
	}));
};

const getUserNameById = async (userId: string | null) => {
	if (!userId) return null;
	const { data } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
	return data?.name ?? null;
};

const resolveAssigneeId = ({
	requestedAssigneeId,
	fallbackAssigneeId,
	eligibleAssignees
}: {
	requestedAssigneeId?: string | null;
	fallbackAssigneeId?: string | null;
	eligibleAssignees: Set<string>;
}) => {
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

const logAgentAssigneeChange = async ({
	workspaceId,
	issueId,
	assigneeId
}: {
	workspaceId: string;
	issueId: string;
	assigneeId?: string | null;
}) => {
	if (!workspaceId || !issueId || !assigneeId) return;
	await supabase.from('activity_logs').insert({
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

const createIssue = async ({
	name,
	unitId,
	workspaceId,
	assigneeId,
	description
}: {
	name: string;
	unitId: string | null;
	workspaceId: string;
	assigneeId?: string | null;
	description?: string | null;
}) => {
	const { data, error } = await supabase
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
		issueId: data.id as string,
		assigneeId
	});
	return data.id as string;
};

const buildIssueDescriptionFallback = ({
	status,
	assigneeName,
	subject,
	body
}: {
	status: string;
	assigneeName: string | null;
	subject: string;
	body: string;
}) => {
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
}: {
	reporterName: string | null;
	assigneeName: string | null;
	subject: string;
	body: string;
	issueTitle: string | null;
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

const buildSubissueDescriptionFallback = ({
	name,
	reasoning
}: {
	name: string;
	reasoning: string | null;
}) => {
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

const normalizeOneLine = (value: string, maxLength = 180) => {
	const cleaned = (value ?? '').replace(/\s+/g, ' ').trim();
	if (!cleaned) return '';
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3))}...`;
};

const ensureSentence = (value: string) => {
	const trimmed = value.trim();
	if (!trimmed) return '';
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const isStatusListDescription = (value: string) => /^(todo|in_progress|done)[,;:]/i.test(value);

const createSubissue = async ({
	parentIssueId,
	name,
	unitId,
	workspaceId,
	status,
	reasoning,
	assigneeId,
	description
}: {
	parentIssueId: string;
	name: string;
	unitId: string | null;
	workspaceId: string;
	status: string;
	reasoning: string | null;
	assigneeId?: string | null;
	description?: string | null;
}) => {
	const { data, error } = await supabase
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
		issueId: data.id as string,
		assigneeId
	});
	return data.id as string;
};

const upsertEmailDraft = async ({
	issueId,
	messageId,
	senderEmail,
	recipientEmail,
	recipientEmails,
	subject,
	body,
	userId,
	workspaceId
}: {
	issueId: string;
	messageId: string | null;
	senderEmail: string;
	recipientEmail: string | null;
	recipientEmails: string[] | null;
	subject: string;
	body: string;
	userId: string;
	workspaceId: string;
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
	let draftId: string | null = null;
	let created = false;
	if (messageId) {
		const { data: existingDraft } = await supabase
			.from('email_drafts')
			.select('id')
			.eq('message_id', messageId)
			.maybeSingle();
		if (existingDraft?.id) {
			const result = await supabase.from('email_drafts').update(payload).eq('id', existingDraft.id);
			draftId = existingDraft.id;
			error = result.error;
		} else {
			const result = await supabase.from('email_drafts').insert(payload).select('id').single();
			draftId = result.data?.id ?? null;
			error = result.error;
			created = true;
		}
	} else {
		const { data: existingDraft } = await supabase
			.from('email_drafts')
			.select('id')
			.eq('issue_id', issueId)
			.is('message_id', null)
			.maybeSingle();
		if (existingDraft?.id) {
			const result = await supabase.from('email_drafts').update(payload).eq('id', existingDraft.id);
			draftId = existingDraft.id;
			error = result.error;
		} else {
			const result = await supabase.from('email_drafts').insert(payload).select('id').single();
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
	return { draftId, created };
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
	unitId: string | null;
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
}: {
	subject: string;
	body: string;
	senderEmail: string;
	unitId: string | null;
	unitName: string | null;
	workspaceId: string;
	propertyName: string | null;
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
	workspaceUnits?: Array<{
		id: string;
		name: string | null;
		property_id: string | null;
		property_name: string | null;
		property_address: string | null;
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
	const eligibleAssignees = await listEligibleAssignees(workspaceId);
	const assignees = await listWorkspaceAssignees(workspaceId);
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
	const messages: Array<any> = [
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
	let linkedIssueId: string | null = null;
	let createdIssueId: string | null = null;
	let lastSubissueId: string | null = null;
	let lastSubissueTitle: string | null = null;
	let draftedIssueId: string | null = null;
	let threadLinked = false;
	let resolvedUnitId: string | null = unitId;
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
					const issueId = await createIssue({
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
					const subissueId = await createSubissue({
						parentIssueId,
						name: title,
						unitId: resolvedUnitId,
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

					let issueName = issueNameCache.get(issueIdForReply) ?? '';
					if (!issueName) {
						const { data: issueRow } = await supabase
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
						const result = await upsertEmailDraft({
							issueId: issueIdForReply,
							messageId,
							senderEmail: senderEmailToUse,
							recipientEmail: normalizedRecipient,
							recipientEmails: normalizedRecipient ? [normalizedRecipient] : null,
							subject,
							body: bodyText,
							userId,
							workspaceId
						});
						if (result.created) {
							await createDraftNotification({
								workspaceId,
								issueId: issueIdForReply,
								issueName,
								emailDraftId: result.draftId,
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
						await logAgentError({
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

				if (name === 'draft_email') {
					const issue = typeof args.issue_id === 'string' ? args.issue_id : lastSubissueId;
					const senderEmailToUse = defaultSenderEmail ? normalizeEmail(defaultSenderEmail) : '';
					const recipientList = Array.isArray(args.recipient_emails)
						? args.recipient_emails
								.map((email: unknown) => String(email ?? '').trim())
								.filter(Boolean)
						: [];
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
						const result = await upsertEmailDraft({
							issueId: issue,
							messageId,
							senderEmail: senderEmailToUse,
							recipientEmail: normalizedRecipient,
							recipientEmails: normalizedRecipientList.length
								? normalizedRecipientList
								: normalizedRecipient
									? [normalizedRecipient]
									: null,
							subject,
							body: bodyText,
							userId,
							workspaceId
						});
						if (result.created) {
							await createDraftNotification({
								workspaceId,
								issueId: issue,
								issueName,
								emailDraftId: result.draftId,
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
						await logAgentError({
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
				await logAgentError({
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
			linkedIssueId = await createIssue({
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
	const messageHeaders = message.payload?.headers ?? [];
	const { subject: messageSubject, from: messageFrom } = extractHeaders(messageHeaders);
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

	const workspaceIdForConnection =
		connection.workspace_id ?? (await getWorkspaceIdForUser(connection.user_id));
	if (!workspaceIdForConnection) {
		await logError(connection.user_id, `Workspace lookup failed for user ${connection.user_id}`);
		return;
	}

	const personMatch = await getWorkspacePersonMatch({
		workspaceId: workspaceIdForConnection,
		senderEmail
	});

	const { allow: allowPolicy, block: blockPolicy } = await getPolicyMatch({
		workspaceId: workspaceIdForConnection,
		senderEmail
	});
	if (blockPolicy) {
		await insertIngestionLog({
			userId: connection.user_id,
			source: 'gmail-push',
			detail: JSON.stringify({
				phase: 'skip-blocked-sender',
				sender_email: senderEmail
			})
		});
		return;
	}

	const isBulk = isBulkMessage(messageHeaders);
	if (isBulk && !allowPolicy) {
		await insertIngestionLog({
			userId: connection.user_id,
			source: 'gmail-push',
			detail: JSON.stringify({
				phase: 'skip-bulk',
				sender_email: senderEmail
			})
		});
		return;
	}

	const isRelevant = allowPolicy || isRelevantEmail(messageSubject, cleanedBody);
	if (!isRelevant) {
		await insertIngestionLog({
			userId: connection.user_id,
			source: 'gmail-push',
			detail: JSON.stringify({
				phase: 'skip-nonrelevant',
				sender_email: senderEmail
			})
		});
		return;
	}

	const { data: tenant } = await supabase
		.from('tenants')
		.select('id, unit_id, email, name')
		.ilike('email', senderEmail)
		.maybeSingle();
	const isKnownSender = Boolean(tenant?.id) || Boolean(personMatch?.id);

	if (!tenant?.id || !tenant.unit_id) {
		if (!isKnownSender) {
			await insertIngestionLog({
				userId: connection.user_id,
				source: 'gmail-push',
				detail: JSON.stringify({
					phase: 'skip-unknown-sender',
					sender_email: senderEmail
				})
			});
			return;
		}
		const threadExternalId = message.threadId ?? null;
		let threadRow = null;
		if (threadExternalId) {
			const { error: insertError } = await supabase.from('threads').upsert(
				{
					tenant_id: null,
					participant_type: 'unknown',
					participant_id: null,
					name: messageSubject || 'Gmail thread',
					external_id: threadExternalId,
					connection_id: connection.id,
					workspace_id: workspaceIdForConnection
				},
				{ onConflict: 'external_id', ignoreDuplicates: true }
			);
			if (insertError) {
				await logError(
					connection.user_id,
					`Unknown thread upsert failed: ${insertError?.message ?? 'unknown'}`
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
					tenant_id: null,
					participant_type: 'unknown',
					participant_id: null,
					issue_id: null,
					name: messageSubject || 'Gmail thread',
					external_id: threadExternalId,
					connection_id: connection.id,
					workspace_id: workspaceIdForConnection
				})
				.select('id')
				.single();
			if (threadError || !createdThread?.id) {
				await logError(
					connection.user_id,
					`Unknown thread insert failed: ${threadError?.message ?? 'unknown'}`
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
					sender: 'unknown',
					subject: messageSubject,
					timestamp: new Date(internalDate || Date.now()).toISOString(),
					channel: 'gmail',
					direction: 'inbound',
					delivery_status: 'received',
					connection_id: connection.id,
					issue_id: threadRow.issue_id ?? null,
					thread_external_id: threadExternalId,
					workspace_id: workspaceIdForConnection,
					metadata: { sender_email: senderEmail }
				})
				.select('id')
				.maybeSingle();

			let inboundMessageId = inboundMessage?.id ?? null;
			if (inboundInsertError) {
				if (inboundInsertError.code === '23505') {
					const { data: existingInboundMessage } = await supabase
						.from('messages')
						.select('id')
						.eq('external_id', message.id)
						.maybeSingle();
					inboundMessageId = existingInboundMessage?.id ?? null;
					if (!inboundMessageId) {
						return;
					}
				} else {
					await logError(
						connection.user_id,
						`Inbound insert failed: ${inboundInsertError.message}`
					);
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
				.eq('workspace_id', workspaceIdForConnection)
				.in('type', ['behavior', 'allow'])
				.order('updated_at', { ascending: false })
				.limit(1)
				.maybeSingle();
			const policyText = policyRow?.policy_text ?? '';
			const { data: userProfile } = await supabase
				.from('users')
				.select('name')
				.eq('id', connection.user_id)
				.maybeSingle();
			const userName = userProfile?.name ?? 'Bedrock';
			const workspaceUnits = await listWorkspaceUnitsForAgent(workspaceIdForConnection);

			const created = await runIssueAgent({
				subject: messageSubject,
				body: cleanedBody,
				senderEmail,
				unitId: null,
				unitName: null,
				workspaceId: workspaceIdForConnection,
				propertyName: null,
				threadId: threadRow.id,
				userId: connection.user_id,
				policyText,
				tenantName: null,
				tenantEmail: null,
				userName,
				defaultSenderEmail: connection.email ?? null,
				replyMessageId: inboundMessageId,
				rootIssueId: rootIssueIdForAgent,
				threadIssueId: issueId,
				relatedIssues,
				workspaceUnits
			});
			issueId = created?.issueId ?? issueId;

			if (issueId) {
				await supabase.from('threads').update({ issue_id: issueId }).eq('id', threadRow.id);
				await supabase.from('messages').update({ issue_id: issueId }).eq('thread_id', threadRow.id);
			}
		} finally {
			await supabase.from('threads').update({ processing_at: null }).eq('id', threadRow.id);
		}
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
		.select('id, name, workspace_id')
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
			.in('type', ['behavior', 'allow'])
			.order('updated_at', { ascending: false })
			.limit(1)
			.maybeSingle();
		const policyText = policyRow?.policy_text ?? '';
		const { data: userProfile } = await supabase
			.from('users')
			.select('name')
			.eq('id', connection.user_id)
			.maybeSingle();
		const userName = userProfile?.name ?? 'Bedrock';
		const workspaceUnits = await listWorkspaceUnitsForAgent(propertyRow.workspace_id);
		const created = await runIssueAgent({
			subject: messageSubject,
			body: cleanedBody,
			senderEmail,
			unitId: unitRow.id,
			unitName: unitRow.name ?? null,
			workspaceId: propertyRow.workspace_id,
			propertyName: propertyRow.name ?? null,
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
			relatedIssues,
			workspaceUnits
		});
		issueId = created?.issueId ?? issueId;

		if (issueId) {
			await supabase.from('threads').update({ issue_id: issueId }).eq('id', threadRow.id);

			await supabase.from('messages').update({ issue_id: issueId }).eq('thread_id', threadRow.id);
		}
	} finally {
		await supabase.from('threads').update({ processing_at: null }).eq('id', threadRow.id);
	}
};

const markJobDone = async (jobId: string) => {
	await supabase
		.from('jobs')
		.update({ status: 'done', updated_at: new Date().toISOString() })
		.eq('id', jobId);
};

const markJobError = async (jobId: string, attempts: number, error: string) => {
	await supabase
		.from('jobs')
		.update({
			status: 'error',
			attempts,
			error,
			updated_at: new Date().toISOString()
		})
		.eq('id', jobId);
};

const resetJob = async (jobId: string) => {
	await supabase
		.from('jobs')
		.update({ status: 'pending', updated_at: new Date().toISOString() })
		.eq('id', jobId);
};

const acquireConnectionLock = async (connectionId: string) => {
	const lockCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
	const lockTime = new Date().toISOString();
	const { data: lockRow } = await supabase
		.from('gmail_connections')
		.update({ processing_at: lockTime })
		.eq('id', connectionId)
		.is('processing_at', null)
		.select('id')
		.maybeSingle();
	let lockAcquired = Boolean(lockRow?.id);
	if (!lockAcquired) {
		const { data: staleLockRow } = await supabase
			.from('gmail_connections')
			.update({ processing_at: lockTime })
			.eq('id', connectionId)
			.lt('processing_at', lockCutoff)
			.select('id')
			.maybeSingle();
		lockAcquired = Boolean(staleLockRow?.id);
	}
	return lockAcquired;
};

const releaseConnectionLock = async (connectionId: string) => {
	await supabase.from('gmail_connections').update({ processing_at: null }).eq('id', connectionId);
};

const claimJob = async (jobId: string | null) => {
	const now = new Date().toISOString();
	if (jobId) {
		const { data } = await supabase
			.from('jobs')
			.update({ status: 'processing', updated_at: now })
			.eq('id', jobId)
			.eq('status', 'pending')
			.select('*')
			.maybeSingle();
		return data ?? null;
	}
	const { data: nextJob } = await supabase
		.from('jobs')
		.select('*')
		.eq('status', 'pending')
		.order('created_at', { ascending: true })
		.limit(1)
		.maybeSingle();
	if (!nextJob?.id) return null;
	const { data } = await supabase
		.from('jobs')
		.update({ status: 'processing', updated_at: now })
		.eq('id', nextJob.id)
		.eq('status', 'pending')
		.select('*')
		.maybeSingle();
	return data ?? null;
};

serve(async (req) => {
	let currentJobId: string | null = null;
	try {
		if (req.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 });
		}

		const body = await req.json().catch(() => null);
		const jobId = typeof body?.job_id === 'string' ? body.job_id : null;
		const directSource = typeof body?.source === 'string' ? body.source : null;
		if (!jobId && directSource && directSource !== 'gmail') {
			return new Response('Direct comment processing not implemented', { status: 501 });
		}
		const job = await claimJob(jobId);
		if (!job?.id) {
			return new Response(JSON.stringify({ status: 'empty' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		currentJobId = job.id;

		const source = typeof job.source === 'string' ? job.source : 'gmail';
		if (source !== 'gmail') {
			await markJobDone(job.id);
			return new Response(JSON.stringify({ status: 'skipped' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const payload = job.payload ?? {};
		const emailAddress = typeof payload.email === 'string' ? payload.email : '';
		const historyId = payload.history_id ? String(payload.history_id) : '';
		const normalizedEmail = emailAddress ? normalizeEmail(emailAddress) : null;

		if (!normalizedEmail || !historyId) {
			await markJobError(job.id, (job.attempts ?? 0) + 1, 'Invalid job payload');
			return new Response('Invalid payload', { status: 400 });
		}

		const { data: connection } = await supabase
			.from('gmail_connections')
			.select('*')
			.eq('email', normalizedEmail)
			.maybeSingle();

		if (!connection) {
			await markJobDone(job.id);
			return new Response(JSON.stringify({ status: 'ignored' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const lockAcquired = await acquireConnectionLock(connection.id);
		if (!lockAcquired) {
			await resetJob(job.id);
			return new Response(JSON.stringify({ status: 'locked' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		try {
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
				await markJobDone(job.id);
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
					console.error('agent refresh failed', detail);
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
						await markJobDone(job.id);
						return new Response('Token revoked', { status: 200 });
					}
					await markJobError(job.id, (job.attempts ?? 0) + 1, detail);
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
					await markJobDone(job.id);
					return new Response(JSON.stringify({ status: 'reset' }), {
						headers: { 'Content-Type': 'application/json' }
					});
				}
				console.error('agent history error', err);
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

			await markJobDone(job.id);
			return new Response(JSON.stringify({ status: 'ok' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		} finally {
			await releaseConnectionLock(connection.id);
		}
	} catch (err) {
		console.error('agent error', err);
		try {
			if (currentJobId) {
				await markJobError(currentJobId, 1, err instanceof Error ? err.message : 'Internal error');
			}
		} catch {
			// ignore
		}
		return new Response('Internal error', { status: 500 });
	}
});
