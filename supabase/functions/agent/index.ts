// @ts-nocheck
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

let currentWorkspaceId: string | null = null;
let currentUserId: string | null = null;
let currentRunId: string | null = null;
let currentIssueId: string | null = null;

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

const touchIssueUpdatedAt = async (issueId: string | null, parentId?: string | null) => {
	if (!issueId) return;
	const nowIso = new Date().toISOString();
	await supabase.from('issues').update({ updated_at: nowIso }).eq('id', issueId);
	let resolvedParentId = parentId ?? null;
	if (!resolvedParentId) {
		const { data: issueRow } = await supabase
			.from('issues')
			.select('parent_id')
			.eq('id', issueId)
			.maybeSingle();
		resolvedParentId = issueRow?.parent_id ?? null;
	}
	if (resolvedParentId) {
		await supabase.from('issues').update({ updated_at: nowIso }).eq('id', resolvedParentId);
	}
};

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

// Clamp a title to MAX_TITLE_CHARS by trimming at the last word boundary.
// Prevents mid-word truncation while enforcing the character limit.
const MAX_TITLE_CHARS = 30;
const clampTitle = (title: string): string => {
	if (title.length <= MAX_TITLE_CHARS) return title;
	const cut = title.slice(0, MAX_TITLE_CHARS + 1);
	const lastSpace = cut.lastIndexOf(' ');
	return lastSpace > 0 ? title.slice(0, lastSpace).trimEnd() : title.slice(0, MAX_TITLE_CHARS);
};

// Strip all tokens of a tenant's full name from a title string.
// Removes each word of the name individually (case-insensitive) so partial
// matches like first-name-only are also caught.
const stripTenantNameFromTitle = (title: string, tenantName: string | null): string => {
	let result = title;
	if (tenantName) {
		for (const token of tenantName.trim().split(/\s+/)) {
			if (token.length < 2) continue; // skip single chars
			result = result
				.replace(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '')
				.trim();
		}
	}
	// Remove any empty or whitespace-only parentheses left behind, e.g. "()" or "( )"
	result = result.replace(/\(\s*\)/g, '').trim();
	// Collapse any double spaces left behind
	return result.replace(/\s{2,}/g, ' ').trim();
};

const normalizeSubjectTitle = (subject: string) => {
	const cleaned = subject
		.replace(/^\s*(re|fwd|fw)\s*:\s*/gi, '')
		.replace(/^\s*\[[^\]]+\]\s*/g, '')
		.trim();
	return cleaned;
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

const clearStaleProcessingEvents = async ({
	workspaceId,
	threadId,
	runId
}: {
	workspaceId: string;
	threadId: string;
	runId: string;
}) => {
	await supabase
		.from('agent_events')
		.delete()
		.eq('workspace_id', workspaceId)
		.eq('stage', 'processing')
		.is('issue_id', null)
		.neq('run_id', runId)
		.eq('meta->>thread_id', threadId);
};

// Tracks run IDs that have already had their first run-level event inserted.
// Avoids the blind UPDATE→INSERT pattern (2 writes) on first emit for a run.
const _insertedRunLevelEvents = new Set<string>();

const emitAgentEvent = async ({
	workspaceId,
	userId,
	runId,
	step,
	stage,
	message,
	meta,
	issueId
}: {
	workspaceId: string;
	userId: string | null;
	runId: string;
	step: number | null;
	stage: string;
	message: string;
	meta?: Record<string, unknown>;
	issueId?: string | null;
}) => {
	if (!workspaceId || !runId || !stage || !message) return;
	const payload = {
		workspace_id: workspaceId,
		user_id: userId ?? null,
		run_id: runId,
		issue_id: issueId ?? null,
		step: Number.isFinite(step) ? step : null,
		stage,
		message,
		meta: meta ?? {},
		updated_at: new Date().toISOString()
	};

	if (issueId) {
		// Single upsert on workspace_id,issue_id — handles insert and update in one write.
		const { error } = await supabase
			.from('agent_events')
			.upsert(payload, { onConflict: 'workspace_id,issue_id' });
		if (error) {
			console.error('agent-events upsert failed', {
				run_id: runId,
				issue_id: issueId,
				stage,
				error
			});
		}
	} else {
		// Run-level (no issueId): INSERT first time (tracked in module Set), UPDATE thereafter.
		if (_insertedRunLevelEvents.has(runId)) {
			const { error } = await supabase
				.from('agent_events')
				.update({
					step: payload.step,
					stage: payload.stage,
					message: payload.message,
					meta: payload.meta,
					updated_at: payload.updated_at
				})
				.eq('run_id', runId)
				.is('issue_id', null);
			if (error) {
				console.error('agent-events update failed', { run_id: runId, stage, error });
			}
		} else {
			const { error } = await supabase.from('agent_events').insert(payload);
			if (error) {
				console.error('agent-events insert failed', { run_id: runId, stage, error });
			} else {
				_insertedRunLevelEvents.add(runId);
			}
		}
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

const rankVendors = (
	vendors: Array<{ id: string; name: string; email: string | null; trade: string | null }>,
	chosenVendor: { id: string; name: string; email: string | null; trade: string | null } | undefined
): Array<{ id: string; name: string; trade: string | null; email: string | null; score: number; reason: string }> => {
	const chosenTrade = (chosenVendor?.trade ?? '').toLowerCase().trim();
	const alternatives = vendors
		.filter((v) => v.id !== chosenVendor?.id)
		.map((v) => {
			const vTrade = (v.trade ?? '').toLowerCase().trim();
			let score = 3;
			let reason = 'Available vendor in this workspace';
			if (chosenTrade && vTrade) {
				if (vTrade === chosenTrade) {
					score = 2;
					reason = 'Trade match for this work order';
				} else if (vTrade.includes(chosenTrade) || chosenTrade.includes(vTrade)) {
					score = 2;
					reason = 'Available vendor for related trade';
				}
			}
			return { id: v.id, name: v.name, trade: v.trade, email: v.email, score, reason };
		})
		.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

	const result: Array<{
		id: string;
		name: string;
		trade: string | null;
		email: string | null;
		score: number;
		reason: string;
	}> = [];

	if (chosenVendor) {
		result.push({
			id: chosenVendor.id,
			name: chosenVendor.name,
			trade: chosenVendor.trade,
			email: chosenVendor.email,
			score: 1,
			reason: chosenTrade ? 'Trade match for this work order' : 'Agent recommended vendor'
		});
	}

	const slots = chosenVendor ? 2 : 3;
	alternatives.slice(0, slots).forEach((v, idx) => {
		result.push({ ...v, score: idx + (chosenVendor ? 2 : 1) });
	});

	return result;
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
		.select('admin_user_id, default_assignee_id')
		.eq('id', workspaceId)
		.maybeSingle();
	return data?.admin_user_id ?? null;
};

const getWorkspaceDefaultAssigneeId = async (workspaceId: string) => {
	const { data } = await supabase
		.from('workspaces')
		.select('default_assignee_id, admin_user_id')
		.eq('id', workspaceId)
		.maybeSingle();
	return data?.default_assignee_id ?? data?.admin_user_id ?? null;
};

const getWorkspaceIdForUser = async (userId: string) => {
	const { data } = await supabase
		.from('people')
		.select('workspace_id')
		.eq('user_id', userId)
		.in('role', ['admin', 'bedrock', 'member', 'owner'])
		.maybeSingle();
	if (data?.workspace_id) return data.workspace_id;
	const { data: member } = await supabase
		.from('members')
		.select('workspace_id')
		.eq('user_id', userId)
		.in('role', ['admin', 'bedrock', 'member', 'owner'])
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

const buildUrgencyPolicyText = (rows: Array<any>) => {
	const lines = (rows ?? [])
		.map((row) => {
			const meta = row?.meta ?? {};
			const issue =
				typeof meta?.maintenance_issue === 'string'
					? meta.maintenance_issue.trim()
					: typeof row?.description === 'string'
						? row.description.trim()
						: '';
			if (!issue) return null;
			const urgency = typeof meta?.urgency === 'string' ? meta.urgency.trim() : 'not_urgent';
			if (urgency === 'urgent') {
				return `- ${issue}: urgent (schedule vendor immediately; create triage + schedule subissues in the same run)`;
			}
			if (urgency === 'not_urgent') {
				return `- ${issue}: not_urgent (default triage flow)`;
			}
			return `- ${issue}: ${urgency} (default triage flow)`;
		})
		.filter(Boolean);

	if (!lines.length) return '';
	return `Urgency policies:\n${lines.join('\n')}`;
};

const normalizePolicyLabel = (value: string) =>
	(value ?? '')
		.toString()
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ');

const findUrgencyPolicyMatch = (rows: Array<any>, haystack: string) => {
	const normalizedHaystack = normalizePolicyLabel(haystack);
	if (!normalizedHaystack) return null;
	const haystackTokens = normalizedHaystack.split(' ').filter(Boolean);
	for (const row of rows ?? []) {
		const meta = row?.meta ?? {};
		const issue =
			typeof meta?.maintenance_issue === 'string'
				? meta.maintenance_issue
				: typeof row?.description === 'string'
					? row.description
					: '';
		const normalizedIssue = normalizePolicyLabel(issue);
		if (!normalizedIssue) continue;
		const issueTokens = normalizedIssue.split(' ').filter(Boolean);
		const tokenMatch = issueTokens.length
			? issueTokens.every((token) =>
					haystackTokens.some((hay) => hay.startsWith(token) || token.startsWith(hay))
				)
			: false;
		if (normalizedHaystack.includes(normalizedIssue) || tokenMatch) {
			const urgency = typeof meta?.urgency === 'string' ? meta.urgency.trim() : null;
			return urgency === 'urgent' || urgency === 'not_urgent' ? urgency : null;
		}
	}
	return null;
};

const shouldMarkUrgent = (subject: string, body: string, issueName: string | null) => {
	const combined = `${subject ?? ''} ${body ?? ''} ${issueName ?? ''}`;
	return /\b(pest|pests|roach|bed\s*bug|rat|rats|gas\s*leak|gas\s*smell|no\s*power|power\s*outage|no\s*water|flood|flooding|smoke|fire|carbon\s*monoxide|co\s*detector|safety\s*risk)\b/i.test(
		combined
	);
};

const getUrgencyDecision = (
	rows: Array<any>,
	subject: string,
	body: string,
	issueTitle: string | null
) => {
	const policyMatch = findUrgencyPolicyMatch(
		rows,
		`${subject ?? ''} ${body ?? ''} ${issueTitle ?? ''}`
	);
	if (policyMatch === 'urgent') return true;
	if (policyMatch === 'not_urgent') return false;
	return shouldMarkUrgent(subject, body, issueTitle) ? true : null;
};

const listEligibleAssignees = async (workspaceId: string): Promise<Set<string>> => {
	const { data } = await supabase
		.from('members')
		.select('user_id, role')
		.eq('workspace_id', workspaceId)
		.in('role', ['admin', 'bedrock', 'member', 'owner']);
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
		.in('role', ['admin', 'bedrock', 'member', 'owner']);
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

/** Convert AppFolio "Lastname, Firstname" → "Firstname Lastname". Pass-through if no comma. */
const normalizeTenantName = (name: string | null | undefined): string | null => {
	if (!name) return null;
	const trimmed = name.trim();
	if (trimmed.includes(',')) {
		const [last, ...rest] = trimmed.split(',');
		const first = rest.join(',').trim();
		return first ? `${first} ${last.trim()}` : last.trim();
	}
	return trimmed;
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
	description,
	urgent
}: {
	name: string;
	unitId: string | null;
	workspaceId: string;
	assigneeId?: string | null;
	description?: string | null;
	urgent?: boolean | null;
}) => {
	const { data, error } = await supabase
		.from('issues')
		.insert({
			name,
			unit_id: unitId ?? null,
			workspace_id: workspaceId,
			status: 'todo',
			assignee_id: assigneeId ?? null,
			description: description ?? null,
			urgent: typeof urgent === 'boolean' ? urgent : undefined
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
	description,
	urgent
}: {
	parentIssueId: string;
	name: string;
	unitId: string | null;
	workspaceId: string;
	status: string;
	reasoning: string | null;
	assigneeId?: string | null;
	description?: string | null;
	urgent?: boolean | null;
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
			description: description ?? null,
			urgent: typeof urgent === 'boolean' ? urgent : undefined
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
	workspaceId,
	channel = 'email'
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
	channel?: string;
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
		updated_at: new Date().toISOString(),
		channel
	};

	let error = null;
	let draftId: string | null = null;
	let created = false;
	if (messageId) {
		const { data: existingDraft } = await supabase
			.from('drafts')
			.select('id')
			.eq('message_id', messageId)
			.eq('channel', channel)
			.maybeSingle();
		if (existingDraft?.id) {
			const result = await supabase.from('drafts').update(payload).eq('id', existingDraft.id);
			draftId = existingDraft.id;
			error = result.error;
		} else {
			const result = await supabase.from('drafts').insert(payload).select('id').single();
			draftId = result.data?.id ?? null;
			error = result.error;
			created = true;
		}
	} else {
		const { data: existingDraft } = await supabase
			.from('drafts')
			.select('id')
			.eq('issue_id', issueId)
			.is('message_id', null)
			.eq('channel', channel)
			.maybeSingle();
		if (existingDraft?.id) {
			const result = await supabase.from('drafts').update(payload).eq('id', existingDraft.id);
			draftId = existingDraft.id;
			error = result.error;
		} else {
			const result = await supabase.from('drafts').insert(payload).select('id').single();
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const linkThreadToIssue = async ({ threadId, issueId }: { threadId: string; issueId: string }) => {
	if (!UUID_RE.test(threadId)) {
		// threadId is not a valid UUID (e.g. the model passed "appfolio") — skip silently
		return false;
	}
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

const runIssueAgent = async ({
	subject,
	body,
	senderEmail,
	unitId,
	propertyId,
	unitName,
	workspaceId,
	propertyName,
	threadId,
	userId,
	policyText,
	urgencyDecision,
	tenantName,
	tenantEmail,
	userName,
	defaultSenderEmail,
	replyMessageId,
	rootIssueId,
	threadIssueId,
	relatedIssues,
	workspaceUnits,
	source,
	runId: providedRunId,
	skipInitialEvent
}: {
	subject: string;
	body: string;
	senderEmail: string;
	unitId: string | null;
	propertyId?: string | null;
	unitName: string | null;
	workspaceId: string;
	propertyName: string | null;
	threadId: string | null;
	userId: string;
	policyText: string;
	urgencyDecision: boolean | null;
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
	source?: string | null;
	runId?: string | null;
	skipInitialEvent?: boolean;
}) => {
	const system = `You are Bedrock, an assistant for property management.
Your job is to link this email thread to the most specific issue (prefer a subissue when appropriate). If no match exists, create a new issue and then create one subissue for the next step.

Process (required):
1) Review the provided open_issues list.
2) If root_issue_id is provided, do not create a new issue. Use it as the root issue id.
3) If no existing_issue_id is provided and no clear match exists, call create_issue with a concise title. This is required before creating subissues.
4) If existing_issue_id is provided, prefer reusing the most recent triage subissue from open_issues that matches the issue. Only create a new triage subissue if no suitable triage subissue exists.
5) If the tenant indicates troubleshooting failed or the issue cannot be resolved by the tenant, create a Schedule subissue for a vendor (even if you reused the triage subissue) and shift the workflow to scheduling. This is a stopping point: do not continue triage back-and-forth.
6) If the email is from a tenant, follow staged triage unless an urgency policy overrides it:
   - Stage 1: Identify if the tenant can resolve the issue themselves with basic steps.
   - Stage 2: Determine if a vendor is needed.
   - Stage 3: Determine if it is an emergency.
   Use the full conversation thread for context and ask clarifying questions to confirm urgency.
   Choose triage when the tenant might resolve it or more info is needed; choose schedule only for clear emergencies (e.g., pests, gas smell, no power, no water, flooding, safety risks) or when workspace_policy explicitly requires immediate scheduling.
   Example: a clogged toilet is typically triage (suggest using a plunger and ask if there is overflow/flooding). If there is flooding or safety risk, treat as emergency and schedule.
7) If workspace_policy marks the issue as urgent, schedule immediately in the first pass: create the root issue (if needed), then create a triage subissue and a schedule subissue in the same run.
   - The triage subissue reply must tell the tenant that a vendor is being scheduled.
   - The schedule subissue must include a vendor request draft.
   - Do not wait for triage results in this case.
8) If you created a triage subissue, create an email draft reply to the tenant using draft_reply (required).
9) When you determine the tenant cannot resolve the issue and you create a Schedule subissue, you should create two drafts in the same run:
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
- Issue title: 2-5 words, Title Case, no location, no unit/building names, no tenant names. Maximum 30 characters. Write a complete, grammatically natural phrase — never truncate mid-word or mid-thought.
- Issue description: required when creating an issue. One line only, super concise, human readable summary of the current state. Include who reported it (name if known) and what the issue is. Avoid quoting the email body. Avoid list/CSV formatting; write a sentence.
- Issue urgency: when creating the root issue, set the urgent field.
  - Use workspace_policy urgency rules and emergency heuristics to decide.
  - If the workspace_policy marks it urgent, set urgent=true.
  - If the workspace_policy marks it not_urgent, set urgent=false.
  - If no policy applies but emergency heuristics apply, set urgent=true.
  - If unsure, omit urgent.
- Status must be 'todo' when creating a new issue.
- Subissue title format (max 30 characters, must be grammatically complete):
  - Triage {Issue Title}
  - Schedule {Vendor Type} for {Issue Title}
  - Never include the tenant's name or any person's name anywhere in a title.
  - If the full format exceeds 30 characters, shorten the issue title portion — keep it natural and readable, never cut off mid-word.
- Subissue parent rules: Triage and Schedule subissues must use root_issue_id as parent. Never use thread_issue_id as the parent for Schedule.
- Subissue description: required. One line only, super concise, human readable summary of why this subissue exists (use the reasoning as a base). Make it specific to the subissue stage (triage vs schedule) and the reason for that stage (tenant-fixable, policy requirement, etc.). Avoid quoting the email body. Avoid list/CSV formatting; write a sentence.
- Reasoning: keep as a short, human-readable sentence that can be reused for the subissue description.
- Use the workspace_policy to decide triage vs schedule vendor. If the policy instructs drafting emails to cleaners or vendors, do that and skip draft_reply unless the policy explicitly says to reply.
- Drafts: Always write from the property manager POV (the user). Never write from the tenant POV.
 - Drafts: For tenant replies, address the tenant by first name only (e.g., "Hi John," not "Hi John Smith,"). Extract the first name from tenant_name. Never infer a name from the email address.
 - Drafts: For tenant replies, keep it short and direct. Acknowledge the issue, state the immediate next action, and ask only essential follow-up questions.
 - Drafts: For tenant replies, do not ask about availability, timing windows, or scheduling details.
- Drafts: For tenant replies, do not repeat the issue details back to the tenant. Use a generic acknowledgment like "Thanks for reporting this issue." then state the next action.
- Drafts: For tenant replies, ask only one specific follow-up question (may include 2-3 subparts if needed).
 - Drafts: For tenant replies, keep the structure consistent across messages: short acknowledgment, next action, single follow-up question, then signature.
 - Drafts: For tenant replies, ask direct yes/no questions ("Is there active leaking now?") instead of hedged phrasing ("Can you confirm...").
 - Drafts: For tenant replies, do not include apologies or sympathy phrases (e.g., "Sorry to hear that").
 - Drafts: For tenant replies, do not say "triage" or describe internal workflow stages; only state the concrete next action (e.g., "We will send a vendor to take a look").
 - Drafts: For tenant replies, do not mention property_name or unit_name in the body.
 - Drafts: For tenant replies, do not explain assessment criteria or internal process; only state what will happen next.
- Drafts: End with the user_name as the signature. Never use an email address as the signature.
- Drafts: Never use default_sender_email in the email body.
 - Drafts: When referencing location in vendor emails, use property_name and unit_name (e.g., "at {property_name}, unit {unit_name}"). Never include a raw UUID in the email body.
- Drafts: When triaging, draft a short, friendly reply acknowledging the issue and asking one clarifying question about emergency indicators if relevant.
 - Drafts: Vendor requests should be short and direct. Include only the issue, location (property_name + unit_name), and tenant contact information if available.
- Drafts: Use draft_reply for replies and draft_email for new outbound emails.
- Drafts: For Schedule subissues, the draft recipient must be a vendor email or null; never send to sender_email.
- Drafts: sender_email should not be provided by the agent. The system will use default_sender_email.
- Drafts: When provided, pass recipient_email as a plain email address (no display name).
- Drafts: If emailing multiple recipients, pass recipient_emails as an array of plain email addresses.
- root_issue_id: When present, you must not call create_issue. Reuse existing subissues when possible.
- Drafts: Use the subissue id for issue_id. For replies, use latest_message_id for message_id. For vendor scheduling drafts, use draft_email for new outreach and draft_reply for replies; include message_id only when replying in an existing vendor thread, otherwise omit it entirely (do not send empty string).
- Linking: Call link_thread_to_issue exactly once and only after issue/subissue creation. This is required.
- Assignees: When creating issues/subissues, set assignee_id to a user id from eligible_assignees. If unsure, omit it and default to default_assignee_id.
Tenant identity:
- tenant_name and tenant_email come from the tenants table lookup by sender email. These are authoritative.
User identity:
- user_name is the property manager name. You are drafting on behalf of user_name.
Issue context:
- root_issue_id is the root issue for this thread.
- thread_issue_id is the issue currently linked to the email thread (often triage).
- related_issues are the root issue and its subissues; use them to reason about structure.
When you believe you have completed the task, call done().
${
	source === 'appfolio' && rootIssueId
		? `
AppFolio source rules (override ALL general draft rules below):
IMPORTANT: The current issue title and description are the VERBATIM raw work order text copied directly from AppFolio. They must ALWAYS be cleaned up regardless of how short or readable they appear.
- Step 1 — MANDATORY FIRST ACTION: Call update_issue before any other tool call. No exceptions.
  - title: 2-5 words, Title Case, maximum 30 characters (e.g., "Leaky Kitchen Faucet", "Broken AC Unit", "Clogged Drain", "Ant Infestation", "Broken Washer"). No location, no unit names, no tenant names. Never copy the work order text. Write a complete, grammatically natural phrase.
  - description: one concise sentence summarising who reported it and what the problem is. Never copy the work order text verbatim.
- Step 2: Create a triage subissue (and a schedule subissue if a vendor is clearly needed).
- Step 3: Call draft_appfolio using the triage subissue id as issue_id. Draft a short message to the tenant acknowledging the work order and any next steps. Do NOT set recipient_email on this call — it is a tenant acknowledgement, not a vendor message.
- Step 3b (only if you created a schedule subissue in Step 2): Call draft_appfolio again, this time using the schedule subissue id as issue_id. Pick the best vendor from the vendors list (prefer trade match). Set recipient_email to that vendor's email. Draft a brief work order request to the vendor describing the issue. This creates the vendor assignment draft that the property manager will review and approve.
- Step 4: Call done().
`.trim()
		: ''
}`.trim();
	const updateIssueTool = {
		type: 'function',
		name: 'update_issue',
		description: 'Update the title and description of the root AppFolio issue',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				title: { type: 'string' },
				description: { type: 'string' }
			},
			required: ['title', 'description']
		}
	};
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
				description: { type: 'string' },
				urgent: { type: 'boolean' }
			},
			required: ['title', 'workspace_id', 'description']
		}
	};
	const linkThreadTool = {
		type: 'function',
		name: 'link_thread_to_issue',
		description:
			'Attach a thread to an issue. issue_id must be a UUID returned by create_issue or create_subissue — never an email address.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				thread_id: { type: 'string' },
				issue_id: {
					type: 'string',
					description:
						'UUID of the issue or subissue (from create_issue/create_subissue result), not an email address'
				}
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
				description: { type: 'string' },
				urgent: { type: 'boolean' }
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
	const draftAppfolioTool = {
		type: 'function',
		name: 'draft_appfolio',
		description:
			'Create or update a draft AppFolio message for the tenant (use for AppFolio work orders instead of draft_email or draft_reply)',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				issue_id: { type: 'string' },
				subject: { type: 'string' },
				body: { type: 'string' },
				recipient_email: { type: 'string', description: 'Tenant email address (optional)' }
			},
			required: ['issue_id', 'subject', 'body']
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
		...(rootIssueId && source === 'appfolio' ? [updateIssueTool] : []),
		linkThreadTool,
		createSubissueTool,
		...(source === 'appfolio' ? [draftAppfolioTool] : [draftEmailTool, draftReplyTool]),
		doneTool
	];

	const openIssues = await listOpenIssues(unitId);
	const vendors = await listVendors(workspaceId);
	const workspaceAdminId = await getWorkspaceAdminId(workspaceId);
	const defaultAssigneeId = await getWorkspaceDefaultAssigneeId(workspaceId);
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
	if (defaultAssigneeId && !assigneeNameById.has(defaultAssigneeId)) {
		const defaultName = await getUserNameById(defaultAssigneeId);
		assigneeNameById.set(defaultAssigneeId, defaultName);
		assignees.push({ id: defaultAssigneeId, name: defaultName });
	}
	if (workspaceAdminId) {
		eligibleAssignees.add(workspaceAdminId);
	}
	if (defaultAssigneeId) {
		eligibleAssignees.add(defaultAssigneeId);
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
				default_assignee_id: defaultAssigneeId,
				workspace_units: workspaceUnits ?? []
			})
		}
	];

	const runId = providedRunId ?? crypto.randomUUID();
	let startedEventSent = Boolean(skipInitialEvent);
	let linkedIssueId: string | null = null;
	let createdIssueId: string | null = null;
	let lastSubissueId: string | null = null;
	let lastSubissueTitle: string | null = null;
	let lastTriageSubissueId: string | null = null;
	let draftedIssueId: string | null = null;
	let threadLinked = false;
	let resolvedUnitId: string | null = unitId;
	let resolvedPropertyId: string | null = propertyId ?? null;
	let primaryIssueId: string | null = rootIssueId ?? threadIssueId ?? null;
	const issueNameCache = new Map<string, string>();
	const urgencyHint = urgencyDecision === true ? true : urgencyDecision === false ? false : null;

	for (let i = 0; i < 10; i += 1) {
		if (!startedEventSent) {
			await emitAgentEvent({
				workspaceId,
				userId,
				runId,
				step: i,
				stage: 'processing',
				message: 'Processing email',
				meta: {
					thread_id: threadId,
					property_name: propertyName ?? null,
					unit_name: unitName ?? null
				}
			});
			startedEventSent = true;
		}
		let response: Response | null = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			response = await fetch('https://api.openai.com/v1/responses', {
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
			if (response.ok) break;
			const errText = await response.text();
			if (response.status === 429 && attempt < 3) {
				const retryAfter = Number(response.headers.get('retry-after') ?? attempt * 10);
				console.warn(`OpenAI rate limit on attempt ${attempt}/3, retrying in ${retryAfter}s`);
				await new Promise((r) => setTimeout(r, retryAfter * 1000));
			} else {
				throw new Error(errText);
			}
		}
		if (!response || !response.ok) {
			throw new Error('OpenAI request failed after retries');
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

			const stageMessageByName: Record<string, string> = {
				create_issue: 'Creating root issue',
				create_subissue: 'Creating subissues',
				draft_email: 'Drafting emails',
				draft_reply: 'Drafting emails',
				draft_appfolio: 'Drafting message'
			};
			const stageMessage = stageMessageByName[name];
			const issueIdForEvent =
				primaryIssueId ??
				createdIssueId ??
				linkedIssueId ??
				rootIssueId ??
				threadIssueId ??
				(typeof args.parent_issue_id === 'string' ? args.parent_issue_id : null) ??
				(typeof args.issue_id === 'string' ? args.issue_id : null) ??
				lastSubissueId;
			if (stageMessage && (issueIdForEvent || name !== 'create_issue')) {
				const meta: Record<string, unknown> = {
					thread_id: threadId,
					property_name: propertyName ?? null,
					unit_name: unitName ?? null
				};
				if (name === 'create_subissue') {
					meta.parent_issue_id =
						typeof args.parent_issue_id === 'string' ? args.parent_issue_id : null;
				}
				if (name === 'draft_email' || name === 'draft_reply') {
					meta.issue_id = typeof args.issue_id === 'string' ? args.issue_id : null;
					if (typeof args.message_id === 'string') meta.message_id = args.message_id;
				}
				await emitAgentEvent({
					workspaceId,
					userId,
					runId,
					step: i,
					stage: name,
					message: stageMessage,
					meta,
					issueId: issueIdForEvent ?? null
				});
			}
			try {
				if (name === 'update_issue') {
					const title =
						typeof args.title === 'string'
							? clampTitle(stripTenantNameFromTitle(args.title.trim(), tenantName))
							: '';
					const desc = typeof args.description === 'string' ? args.description.trim() : '';
					if (rootIssueId) {
						const updates: Record<string, string | null> = {};
						if (title) updates.name = title;
						if (desc) updates.description = desc;
						if (Object.keys(updates).length) {
							await supabase.from('issues').update(updates).eq('id', rootIssueId);
						}
					}
					issuedAction = true;
					result = { ok: true };
				}

				if (name === 'create_issue') {
					const title =
						typeof args.title === 'string'
							? clampTitle(stripTenantNameFromTitle(args.title.trim(), tenantName))
							: '';
					const unit = typeof args.unit_id === 'string' ? args.unit_id : unitId;
					const workspace = typeof args.workspace_id === 'string' ? args.workspace_id : workspaceId;
					const assignee = defaultAssigneeId;
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
					const urgentValue =
						typeof args.urgent === 'boolean' ? args.urgent : (urgencyHint ?? undefined);
					const issueId = await createIssue({
						name: title,
						unitId: unit,
						workspaceId: workspace,
						assigneeId: assignee,
						description,
						urgent: urgentValue
					});
					await emitAgentEvent({
						workspaceId,
						userId,
						runId,
						step: i,
						stage: 'create_issue',
						message: 'Creating root issue',
						meta: { thread_id: threadId },
						issueId
					});
					if (unit && typeof unit === 'string') {
						resolvedUnitId = unit;
						const unitEntry = workspaceUnits?.find((u) => u.id === unit);
						if (unitEntry?.property_id) resolvedPropertyId = unitEntry.property_id;
					}
					linkedIssueId = issueId;
					createdIssueId = issueId;
					primaryIssueId = primaryIssueId ?? issueId;
					issuedAction = true;
					result = { issue_id: issueId };
				}

				if (name === 'link_thread_to_issue') {
					const thread = typeof args.thread_id === 'string' ? args.thread_id : threadId;
					const issue =
						typeof args.issue_id === 'string' ? args.issue_id : (lastSubissueId ?? linkedIssueId);
					const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
					// AppFolio source: no email thread to link — treat as no-op so the agent
					// can call link_thread_to_issue as usual without crashing.
					if (!thread) {
						threadLinked = true;
						issuedAction = true;
						linkedIssueId = issue ?? linkedIssueId;
						result = { ok: true };
					} else if (!issue) {
						throw new Error('link_thread_to_issue missing issue_id');
					} else if (!UUID_RE.test(issue)) {
						result = {
							error: `issue_id must be a UUID (e.g. from create_issue or create_subissue), got "${issue}". Do not pass email addresses as issue_id.`
						};
					} else {
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
				}

				if (name === 'create_subissue') {
					const title =
						typeof args.title === 'string'
							? clampTitle(stripTenantNameFromTitle(args.title.trim(), tenantName))
							: '';
					const isTriageSubissue = /^triage\s+/i.test(title);
					const statusValue = typeof args.status === 'string' ? args.status : 'todo';
					const status = ['todo', 'in_progress', 'done'].includes(statusValue)
						? statusValue
						: 'todo';
					const reasoning = typeof args.reasoning === 'string' ? args.reasoning : '';
					const requestedParent =
						typeof args.parent_issue_id === 'string' ? args.parent_issue_id : null;
					const assignee = defaultAssigneeId;
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
					const subissueUrgentValue =
						typeof args.urgent === 'boolean' ? args.urgent : (urgencyHint ?? undefined);
					const subissueId = await createSubissue({
						parentIssueId,
						name: title,
						unitId: resolvedUnitId,
						propertyId: resolvedPropertyId,
						workspaceId,
						status,
						reasoning,
						assigneeId: assignee,
						description,
						urgent: subissueUrgentValue
					});
					lastSubissueId = subissueId;
					lastSubissueTitle = title;
					if (isTriageSubissue) {
						lastTriageSubissueId = subissueId;
					}
					issuedAction = true;
					result = { subissue_id: subissueId };
					primaryIssueId = primaryIssueId ?? parentIssueId ?? rootIssueId ?? createdIssueId;
				}

				if (name === 'draft_reply') {
					const issue =
						typeof args.issue_id === 'string'
							? args.issue_id
							: (lastTriageSubissueId ?? lastSubissueId);
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
							workspaceId,
							channel: source === 'appfolio' ? 'appfolio' : 'email'
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
							workspaceId,
							channel: source === 'appfolio' ? 'appfolio' : 'email'
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
					if (isScheduleSubissue && normalizedRecipient && vendors.length > 0) {
						const chosenVendor = vendors.find(
							(v) => v.email && normalizeEmail(v.email) === normalizedRecipient
						);
						const recommended = rankVendors(vendors, chosenVendor ?? undefined);
						if (recommended.length > 0) {
							await supabase
								.from('issues')
								.update({ recommended_vendors: recommended })
								.eq('id', issue);
						}
					}
					draftedIssueId = issue;
					issuedAction = true;
					result = { ok: true };
				}

				if (name === 'draft_appfolio') {
					const issue = typeof args.issue_id === 'string' ? args.issue_id : lastSubissueId;
					const subject = typeof args.subject === 'string' ? args.subject : '';
					const bodyText = typeof args.body === 'string' ? args.body : '';
					const recipientEmail =
						typeof args.recipient_email === 'string' ? args.recipient_email : null;
					if (!issue || !subject || !bodyText) {
						throw new Error('draft_appfolio missing required fields');
					}
					await upsertEmailDraft({
						issueId: issue,
						messageId: null,
						senderEmail: '',
						recipientEmail,
						recipientEmails: null,
						subject,
						body: bodyText,
						userId,
						workspaceId,
						channel: 'appfolio'
					});
					if (recipientEmail && vendors.length > 0) {
						const normalizedRec = normalizeEmail(extractEmail(recipientEmail));
						const chosenVendor = vendors.find(
							(v) => v.email && normalizeEmail(v.email) === normalizedRec
						);
						const recommended = rankVendors(vendors, chosenVendor ?? undefined);
						if (recommended.length > 0) {
							await supabase
								.from('issues')
								.update({ recommended_vendors: recommended })
								.eq('id', issue);
						}
					}
					draftedIssueId = issue;
					issuedAction = true;
					result = { ok: true };
				}

				if (name === 'done') {
					const doneIssueId =
						primaryIssueId ??
						linkedIssueId ??
						draftedIssueId ??
						lastSubissueId ??
						createdIssueId ??
						rootIssueId ??
						(typeof args.issue_id === 'string' ? args.issue_id : null);
					await emitAgentEvent({
						workspaceId,
						userId,
						runId,
						step: i,
						stage: 'done',
						message: 'Done',
						meta: { thread_id: threadId },
						issueId: doneIssueId
					});
					if (threadId) await clearStaleProcessingEvents({ workspaceId, threadId, runId });
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

	// For AppFolio issues: mark as fully processed now that all steps are complete.
	// This makes the issue visible client-side. Set here (not in update_issue) so the
	// issue only appears after title, subissues, and drafts are all done.
	if (source === 'appfolio' && rootIssueId) {
		await supabase
			.from('issues')
			.update({ agent_processed_at: new Date().toISOString() })
			.eq('id', rootIssueId);

		// Notify bedrock users now that the issue is fully processed (cleaned title + description).
		const { data: processedIssue } = await supabase
			.from('issues')
			.select('name, description, assignee_id')
			.eq('id', rootIssueId)
			.maybeSingle();
		const processedTitle = processedIssue?.name?.trim() ?? '';
		const processedDesc = processedIssue?.description?.trim() ?? '';
		const notifTitle = processedTitle ? `New Work Order — ${processedTitle}` : 'New Work Order';
		const { data: bedrockPeople } = await supabase
			.from('people')
			.select('user_id')
			.eq('workspace_id', workspaceId)
			.eq('role', 'bedrock')
			.not('user_id', 'is', null);
		if (bedrockPeople?.length) {
			await supabase.from('notifications').insert(
				bedrockPeople.map((p: any) => ({
					workspace_id: workspaceId,
					issue_id: rootIssueId,
					user_id: p.user_id,
					title: notifTitle,
					body: processedDesc,
					type: 'new_work_order',
					requires_action: true
				}))
			);
		}

		// Notify the assigned PM that the triage draft is ready for their review.
		// This is separate from the bedrock notification — it targets whoever owns the issue.
		const assigneeId = processedIssue?.assignee_id ?? null;
		const bedrockUserIds = new Set((bedrockPeople ?? []).map((p: any) => p.user_id));
		if (assigneeId && !bedrockUserIds.has(assigneeId)) {
			const pmTitle = processedTitle
				? `Draft Ready for Approval — ${processedTitle}`
				: 'Draft Ready for Approval';
			await supabase.from('notifications').insert({
				workspace_id: workspaceId,
				issue_id: rootIssueId,
				user_id: assigneeId,
				title: pmTitle,
				body: processedDesc,
				type: 'triage_approval',
				requires_action: true
			});
		}
	}

	if (threadId && !threadLinked) {
		await logError(userId, 'LLM did not link thread to issue.');
	}

	if (!linkedIssueId) {
		const fallbackIssueId = lastSubissueId ?? createdIssueId;
		if (threadId && fallbackIssueId) {
			await linkThreadToIssue({ threadId, issueId: fallbackIssueId });
			linkedIssueId = fallbackIssueId;
		} else if (fallbackIssueId) {
			// AppFolio source: no thread to link but we have an issue ID — that's fine.
			linkedIssueId = fallbackIssueId;
		} else {
			await logError(userId, 'LLM did not create/link issue.');
		}
	}

	return { issueId: linkedIssueId, runId };
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
	currentWorkspaceId = workspaceIdForConnection;
	currentUserId = connection.user_id;

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

	const runId = crypto.randomUUID();
	currentRunId = runId;
	await emitAgentEvent({
		workspaceId: workspaceIdForConnection,
		userId: connection.user_id,
		runId,
		step: 0,
		stage: 'processing',
		message: 'Processing email',
		meta: { thread_id: message.threadId ?? null }
	});

	const { data: tenant } = await supabase
		.from('tenants')
		.select('id, unit_id, email, name')
		.ilike('email', senderEmail)
		.maybeSingle();
	if (!tenant?.id || !tenant.unit_id) {
		await insertIngestionLog({
			userId: connection.user_id,
			source: 'gmail-push',
			detail: JSON.stringify({
				phase: 'skip-non-tenant',
				sender_email: senderEmail
			})
		});
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

	await emitAgentEvent({
		workspaceId: propertyRow.workspace_id,
		userId: connection.user_id,
		runId,
		step: 0,
		stage: 'processing',
		message: 'Processing email',
		meta: {
			thread_id: message.threadId ?? null,
			property_name: propertyRow.name ?? null,
			unit_name: unitRow.name ?? null
		}
	});

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

	let urgencyPolicies: Array<any> = [];
	try {
		const { data } = await supabase
			.from('workspace_policies')
			.select('meta, description')
			.eq('workspace_id', propertyRow.workspace_id)
			.eq('type', 'urgency')
			.order('updated_at', { ascending: false });
		urgencyPolicies = data ?? [];
	} catch {
		urgencyPolicies = [];
	}

	const urgencyDecision = getUrgencyDecision(
		urgencyPolicies,
		messageSubject ?? '',
		cleanedBody ?? '',
		normalizeSubjectTitle(messageSubject || '')
	);

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
				workspace_id: propertyRow.workspace_id,
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

		await touchIssueUpdatedAt(threadRow.issue_id ?? null);

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
		const urgencyPolicyText = buildUrgencyPolicyText(urgencyPolicies ?? []);
		const policyText = [policyRow?.policy_text ?? '', urgencyPolicyText]
			.filter(Boolean)
			.join('\n\n');
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
			urgencyDecision,
			tenantName: normalizeTenantName(tenant.name ?? null),
			tenantEmail: tenant.email ?? null,
			userName,
			defaultSenderEmail: connection.email ?? null,
			replyMessageId: inboundMessageId,
			rootIssueId: rootIssueIdForAgent,
			threadIssueId: issueId,
			relatedIssues,
			workspaceUnits,
			runId,
			skipInitialEvent: true
		});
		issueId = created?.issueId ?? issueId;
		currentRunId = created?.runId ?? currentRunId;
		currentIssueId = issueId ?? currentIssueId;

		if (issueId) {
			await supabase.from('threads').update({ issue_id: issueId }).eq('id', threadRow.id);
			await supabase
				.from('messages')
				.update({ issue_id: issueId, workspace_id: propertyRow.workspace_id })
				.eq('thread_id', threadRow.id);
			await touchIssueUpdatedAt(issueId);
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

const resetStaleJobs = async () => {
	const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	const now = new Date().toISOString();
	const { data } = await supabase
		.from('jobs')
		.update({ status: 'pending', updated_at: now })
		.eq('status', 'processing')
		.lt('updated_at', cutoff)
		.select('id');
	if (data?.length) {
		console.log('agent job reset-stale', { count: data.length });
	}
};

// ── AppFolio Agent Handler ────────────────────────────────────────────────────

/**
 * Handle an AppFolio-sourced change event from the appfolio-sync edge function.
 * Routes to runIssueAgent (same function as Gmail) for 'new' work orders so there
 * is exactly one agent prompt to maintain across both sources.
 */
const handleAppfolioWorkOrder = async ({
	issueId,
	workspaceId,
	change_type,
	row
}: {
	issueId: string;
	workspaceId: string;
	change_type: string;
	row: any;
}): Promise<void> => {
	// Load workspace admin (used as userId for agent runs that have no human initiator)
	const userId = await getWorkspaceAdminId(workspaceId);
	if (!userId) {
		console.error(`handleAppfolioWorkOrder: no admin for workspace ${workspaceId}`);
		return;
	}

	// ── status_changed: log the transition ───────────────────────────────────
	if (change_type === 'status_changed') {
		const { data: issueRow } = await supabase
			.from('issues')
			.select('appfolio_raw_status')
			.eq('id', issueId)
			.maybeSingle();
		await supabase.from('activity_logs').insert({
			workspace_id: workspaceId,
			issue_id: issueId,
			type: 'status_change',
			data: {
				appfolio_id: row?.work_order_id ? String(row.work_order_id) : null,
				new_status: row?.status ? String(row.status) : null,
				prev_status: issueRow?.appfolio_raw_status ?? null
			}
		});
		return;
	}

	// ── vendor_assigned: log the assignment + notify founders ─────────────────
	if (change_type === 'vendor_assigned') {
		const vendorName = (row?.vendor as string) || null;
		await supabase.from('activity_logs').insert({
			workspace_id: workspaceId,
			issue_id: issueId,
			type: 'assignee_change',
			data: {
				appfolio_vendor_id: row?.vendor_id ? String(row.vendor_id) : null,
				vendor_name: vendorName
			}
		});
		// Notify bedrock-role members in the LAPM workspace to mirror the assignment in AppFolio.
		try {
			const { data: issueRow } = await supabase
				.from('issues')
				.select('name, appfolio_id, readable_id')
				.eq('id', issueId)
				.maybeSingle();
			if (issueRow) {
				const { data: lapm } = await supabase
					.from('workspaces')
					.select('id')
					.eq('slug', 'lapm')
					.maybeSingle();
				if (lapm?.id) {
					const { data: founders } = await supabase
						.from('people')
						.select('user_id')
						.eq('workspace_id', lapm.id)
						.eq('role', 'bedrock');
					if (founders?.length) {
						await supabase.from('notifications').insert(
							founders.map((f: any) => ({
								workspace_id: lapm.id,
								user_id: f.user_id,
								issue_id: issueId,
								title: `AppFolio action needed: vendor assigned on ${issueRow.readable_id ?? issueRow.name}`,
								body: `Vendor "${vendorName ?? 'unknown'}" was assigned in Bedrock for work order ${issueRow.appfolio_id ?? issueRow.readable_id}. Please update vendor assignment in AppFolio.`,
								type: 'appfolio_action_required',
								requires_action: true,
								is_resolved: false,
								meta: { action: 'vendor_assign', vendorName, appfolio_id: issueRow.appfolio_id }
							}))
						);
					}
				}
			}
		} catch (_) {
			/* notification failure should not block sync */
		}
		return;
	}

	// ── notes_changed: log the note + AI check if response needed ─────────────
	if (change_type === 'notes_changed') {
		const newNotes = (row?.status_notes as string) || '(no content)';
		await supabase.from('activity_logs').insert({
			workspace_id: workspaceId,
			issue_id: issueId,
			type: 'appfolio_note',
			data: { body: newNotes, appfolio_id: row?.work_order_id ? String(row.work_order_id) : null }
		});
		// Quick AI check: does this note require a PM response?
		try {
			const openaiKey = Deno.env.get('OPENAI_API_KEY')!;
			const resp = await fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
				body: JSON.stringify({
					model: 'gpt-4o-mini',
					max_tokens: 60,
					messages: [
						{
							role: 'user',
							content: `Does this work order note require a property manager response? Answer YES or NO then one sentence reason.\n\nNote: ${newNotes}`
						}
					]
				})
			});
			const aiJson = await resp.json().catch(() => null);
			const aiText: string = aiJson?.choices?.[0]?.message?.content ?? '';
			if (aiText.toUpperCase().startsWith('YES')) {
				const { data: issueRow } = await supabase
					.from('issues')
					.select('name, readable_id')
					.eq('id', issueId)
					.maybeSingle();
				await supabase.from('notifications').insert({
					workspace_id: workspaceId,
					issue_id: issueId,
					title: `New AppFolio note may need a response — ${issueRow?.readable_id ?? issueRow?.name ?? 'work order'}`,
					body: newNotes.slice(0, 300),
					type: 'appfolio_note',
					requires_action: false
				});
			}
		} catch (_) {
			/* AI check is best-effort */
		}
		return;
	}

	// ── vendor_followup: draft a follow-up and mark as sent ───────────────────
	if (change_type === 'vendor_followup') {
		const { data: issueRow } = await supabase
			.from('issues')
			.select('name, appfolio_id, readable_id, unit_id')
			.eq('id', issueId)
			.maybeSingle();
		if (!issueRow) return;

		// Look up vendor email from people table (matched by appfolio_vendor_id on the issue)
		const { data: issueTracking } = await supabase
			.from('issues')
			.select('appfolio_vendor_id')
			.eq('id', issueId)
			.maybeSingle();
		const vendorEmail: string | null = null; // vendor email lookup deferred — no vendor table yet

		await supabase.from('drafts').insert({
			workspace_id: workspaceId,
			issue_id: issueId,
			recipient_email: vendorEmail,
			subject: `Follow-up: Work Order #${issueRow.appfolio_id ?? issueRow.readable_id ?? issueId}`,
			body: `Hi, this is a follow-up to confirm you received work order #${issueRow.appfolio_id ?? issueId} at ${issueRow.name}. Please reply with your estimated arrival time. Thank you.`,
			channel: 'email'
		});
		await supabase.from('issues').update({ vendor_followup_sent: true }).eq('id', issueId);
		return;
	}

	// ── new: run full agent triage (same prompt as Gmail) ─────────────────────
	if (change_type === 'new') {
		const { data: issueRow } = await supabase
			.from('issues')
			.select('id, name, description, unit_id, property_id')
			.eq('id', issueId)
			.maybeSingle();
		if (!issueRow) return;

		const { data: unitRow } = issueRow.unit_id
			? await supabase.from('units').select('name').eq('id', issueRow.unit_id).maybeSingle()
			: { data: null };
		const { data: propRow } = issueRow.property_id
			? await supabase
					.from('properties')
					.select('name')
					.eq('id', issueRow.property_id)
					.maybeSingle()
			: { data: null };

		const { data: policyRow } = await supabase
			.from('workspace_policies')
			.select('policy_text')
			.eq('workspace_id', workspaceId)
			.in('type', ['behavior', 'allow'])
			.order('updated_at', { ascending: false })
			.limit(1)
			.maybeSingle();
		let urgencyPolicies: Array<any> = [];
		try {
			const { data: upRows } = await supabase
				.from('workspace_policies')
				.select('meta, description')
				.eq('workspace_id', workspaceId)
				.eq('type', 'urgency')
				.order('updated_at', { ascending: false });
			urgencyPolicies = upRows ?? [];
		} catch {
			urgencyPolicies = [];
		}
		const urgencyPolicyText = buildUrgencyPolicyText(urgencyPolicies);
		const policyText = [policyRow?.policy_text ?? '', urgencyPolicyText]
			.filter(Boolean)
			.join('\n\n');

		// Use the default assignee's name as the draft signature, not the workspace admin.
		const defaultAssigneeIdForName = await getWorkspaceDefaultAssigneeId(workspaceId);
		const signatureUserId = defaultAssigneeIdForName ?? userId;
		const { data: userProfile } = await supabase
			.from('users')
			.select('name')
			.eq('id', signatureUserId)
			.maybeSingle();

		const workspaceUnits = await listWorkspaceUnitsForAgent(workspaceId);

		// row may be null for stale re-queues — fall back to the activity_log recorded at issue
		// creation which stores the exact tenant who submitted the work order (data.from / data.from_email).
		let tenantName = normalizeTenantName(row?.primary_tenant ? String(row.primary_tenant) : null);
		let tenantEmail: string | null = row?.primary_tenant_email
			? String(row.primary_tenant_email)
			: null;
		if (!tenantName) {
			const { data: createdLog } = await supabase
				.from('activity_logs')
				.select('data')
				.eq('issue_id', issueId)
				.eq('type', 'issue_created')
				.maybeSingle();
			if (createdLog?.data?.from) tenantName = normalizeTenantName(String(createdLog.data.from));
			if (createdLog?.data?.from_email) tenantEmail = String(createdLog.data.from_email);
		}
		const description = issueRow.description ?? issueRow.name ?? '';

		await runIssueAgent({
			subject: issueRow.name,
			body: description,
			senderEmail: tenantEmail ?? '',
			unitId: issueRow.unit_id ?? null,
			propertyId: issueRow.property_id ?? null,
			unitName: unitRow?.name ?? null,
			workspaceId,
			propertyName: propRow?.name ?? null,
			threadId: null, // AppFolio source — no email thread
			userId,
			policyText,
			urgencyDecision: null,
			tenantName,
			tenantEmail,
			userName: userProfile?.name ?? 'Bedrock',
			defaultSenderEmail: null,
			replyMessageId: null,
			rootIssueId: issueId, // issue already exists — skip create_issue
			workspaceUnits,
			source: 'appfolio',
			runId: null
		});
	}
};

serve(async (req) => {
	let currentJobId: string | null = null;
	try {
		if (req.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 });
		}

		// Internal shared-secret auth for edge-function-to-edge-function calls (e.g. appfolio-sync).
		// If the header is present it MUST match — rejects invalid keys before any processing.
		// Absence is allowed so that existing JWT-authenticated callers (SvelteKit server) still work.
		const internalKey = req.headers.get('x-internal-agent-key');
		if (internalKey !== null) {
			const INTERNAL_AGENT_KEY = Deno.env.get('INTERNAL_AGENT_KEY');
			if (!INTERNAL_AGENT_KEY || internalKey !== INTERNAL_AGENT_KEY) {
				console.error('agent: invalid x-internal-agent-key');
				return new Response('Unauthorized', { status: 401 });
			}
		}

		await resetStaleJobs();
		const body = await req.json().catch(() => null);
		const jobId = typeof body?.job_id === 'string' ? body.job_id : null;
		const directSource = typeof body?.source === 'string' ? body.source : null;

		// AppFolio change events arrive directly (no job queue) from appfolio-sync.
		if (!jobId && directSource === 'appfolio') {
			const { issueId, workspaceId: wsId, change_type, row } = body ?? {};
			if (!issueId || !wsId || !change_type) {
				return new Response('Missing issueId, workspaceId, or change_type', { status: 400 });
			}
			try {
				await handleAppfolioWorkOrder({
					issueId,
					workspaceId: wsId,
					change_type,
					row: row ?? null
				});
				return Response.json({ ok: true });
			} catch (err) {
				console.error('handleAppfolioWorkOrder error:', err);
				return Response.json({ ok: false, error: String(err) }, { status: 500 });
			}
		}

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
		console.log('agent job claimed', {
			job_id: job.id,
			source: job.source,
			payload: job.payload
		});

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
			console.log('agent job no-connection', {
				job_id: job.id,
				email: normalizedEmail
			});
			await markJobDone(job.id);
			return new Response(JSON.stringify({ status: 'ignored' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const lockAcquired = await acquireConnectionLock(connection.id);
		if (!lockAcquired) {
			console.log('agent job lock-skip', {
				job_id: job.id,
				connection_id: connection.id
			});
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
			console.log('agent job history', {
				job_id: job.id,
				history_id: historyId,
				items: historyItems.length
			});
			const messageIds = new Set<string>();
			for (const item of historyItems) {
				for (const msg of item.messagesAdded ?? []) {
					if (msg.message?.id) {
						messageIds.add(msg.message.id);
					}
				}
			}
			console.log('agent job messages', {
				job_id: job.id,
				message_count: messageIds.size
			});

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
			console.log('agent job done', { job_id: job.id });
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
			await emitAgentEvent({
				workspaceId: currentWorkspaceId ?? null,
				userId: currentUserId ?? null,
				runId: currentRunId ?? crypto.randomUUID(),
				step: null,
				stage: 'error',
				message: err instanceof Error ? err.message : 'Agent error',
				meta: {},
				issueId: currentIssueId ?? null
			});
		} catch {
			// ignore
		}
		return new Response('Internal error', { status: 500 });
	}
});
