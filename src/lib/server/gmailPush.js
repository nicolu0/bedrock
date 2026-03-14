// @ts-nocheck
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '$env/static/private';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const supabase = supabaseAdmin;

const decodeBase64Url = (input) => {
	const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
	const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
	return Buffer.from(normalized + pad, 'base64').toString('utf-8');
};

const decodeQuotedPrintable = (input) => {
	const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
	return withoutSoftBreaks.replace(/=([0-9A-F]{2})/gi, (_match, hex) =>
		String.fromCharCode(parseInt(hex, 16))
	);
};

const normalizeQuotedPrintable = (input) =>
	/\=\r?\n|=[0-9A-F]{2}/i.test(input) ? decodeQuotedPrintable(input) : input;

const stripHtml = (input) =>
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

const trimQuotedReply = (input) => {
	const markerMatch = input.split(/\nOn .*wrote:\n/i);
	return markerMatch[0].trim();
};

const RELEVANCE_REGEX =
	/\b(maintenance|repair|fix|broken|leak|leaking|water damage|flood|clog|plumb|hvac|air[- ]?cond|ac\b|heater|heating|thermostat|electrical|power outage|no power|gas leak|gas smell|smoke|alarm|mold|pest|bug|roach|bed ?bug|rat|rats|sewer|toilet|sink|shower|bath|pipe|burst|lock|key|window|door|appliance|fridge|oven|stove|dishwasher|laundry|washer|dryer|rent|payment|invoice|late fee|lease|move[- ]?in|move[- ]?out|eviction|deposit|booking|reservation|check[- ]?in|check[- ]?out|cleaning|housekeep|turnover|short[- ]?term|long[- ]?term|airbnb|vrbo|guest)\b/i;

const isRelevantEmail = (subject, body) => {
	const combined = `${subject || ''}\n${body || ''}`;
	return RELEVANCE_REGEX.test(combined);
};

const extractHeaders = (headers) => {
	const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
	const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
	return { subject, from };
};

const extractEmail = (fromValue) => {
	const match = fromValue.match(/<([^>]+)>/);
	if (match?.[1]) return match[1].trim();
	return fromValue.trim();
};

const normalizeEmail = (value) => value.trim().toLowerCase();

const getHeaderValue = (headers, name) =>
	headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const isBulkMessage = (headers) => {
	const listUnsubscribe = getHeaderValue(headers, 'List-Unsubscribe');
	const listId = getHeaderValue(headers, 'List-Id');
	const precedence = getHeaderValue(headers, 'Precedence');
	const autoSubmitted = getHeaderValue(headers, 'Auto-Submitted');
	if (listUnsubscribe || listId) return true;
	if (/\b(bulk|list|junk)\b/i.test(precedence)) return true;
	if (autoSubmitted && !/\bno\b/i.test(autoSubmitted)) return true;
	return false;
};

const findBodyPart = (payload, mimeType) => {
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

const fetchMessage = async (accessToken, messageId) => {
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

const fetchHistory = async (accessToken, historyId) => {
	const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
	url.searchParams.set('startHistoryId', historyId);
	url.searchParams.set('historyTypes', 'messageAdded');

	const response = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${accessToken}` }
	});

	if (!response.ok) {
		const detail = await response.text();
		const error = new Error(detail);
		error.status = response.status;
		throw error;
	}

	return response.json();
};

const fetchProfile = async (accessToken) => {
	const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	if (!response.ok) {
		throw new Error(await response.text());
	}
	return response.json();
};

const insertIngestionLog = async ({ userId, source, detail }) => {
	const trimmed = detail.slice(0, 4000);
	const { error } = await supabase
		.schema('errors')
		.from('ingestion_errors')
		.insert({ user_id: userId, source, detail: trimmed });
	if (error) {
		console.error('gmail-push log insert failed', error);
	}
};

const logError = async (userId, detail) => {
	await insertIngestionLog({ userId, source: 'gmail-push', detail });
};

const getWorkspaceAdminId = async (workspaceId) => {
	const { data } = await supabase
		.from('workspaces')
		.select('admin_user_id')
		.eq('id', workspaceId)
		.maybeSingle();
	return data?.admin_user_id ?? null;
};

const getWorkspaceIdForUser = async (userId) => {
	const { data } = await supabase
		.from('people')
		.select('workspace_id')
		.eq('user_id', userId)
		.in('role', ['admin', 'member', 'owner'])
		.maybeSingle();
	return data?.workspace_id ?? null;
};

const getPolicyMatch = async ({ workspaceId, senderEmail }) => {
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

const listWorkspaceUnitsForAgent = async (workspaceId) => {
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

const createUnknownSenderNotification = async ({
	workspaceId,
	issueId,
	senderEmail,
	subject,
	body,
	messageId,
	threadId,
	userId,
	type
}) => {
	const adminUserId = await getWorkspaceAdminId(workspaceId);
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

	const safeSubject = subject?.trim() || '(no subject)';
	const safeBody = (body ?? '').trim().slice(0, 500);
	const { error } = await supabase.from('notifications').insert({
		workspace_id: workspaceId,
		issue_id: issueId ?? null,
		user_id: adminUserId,
		title: 'Unknown Sender',
		body: safeSubject,
		type,
		requires_action: true,
		meta: {
			sender_email: senderEmail,
			subject: safeSubject,
			body: safeBody,
			message_id: messageId,
			thread_id: threadId
		}
	});
	if (error) {
		await insertIngestionLog({
			userId,
			source: 'notification',
			detail: JSON.stringify({
				reason: 'insert_failed',
				workspace_id: workspaceId,
				error: error.message
			})
		});
	}
};

const processMessage = async ({ connection, accessToken, message, runAgent }) => {
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

	const workspaceIdForConnection = await getWorkspaceIdForUser(connection.user_id);
	if (!workspaceIdForConnection) {
		await logError(connection.user_id, `Workspace lookup failed for user ${connection.user_id}`);
		return;
	}

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

	if (!tenant?.id || !tenant.unit_id) {
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

		if (!allowPolicy) {
			const internalDate = Number(message.internalDate ?? 0);
			const { data: unknownMessage, error: unknownMessageError } = await supabase
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
					issue_id: null,
					thread_external_id: threadExternalId,
					workspace_id: workspaceIdForConnection,
					metadata: { sender_email: senderEmail }
				})
				.select('id')
				.maybeSingle();

			if (unknownMessageError) {
				if (unknownMessageError.code !== '23505') {
					await logError(
						connection.user_id,
						`Unknown message insert failed: ${unknownMessageError?.message ?? 'unknown'}`
					);
					return;
				}
			}

			await createUnknownSenderNotification({
				workspaceId: workspaceIdForConnection,
				issueId: null,
				senderEmail,
				subject: messageSubject,
				body: cleanedBody,
				messageId: unknownMessage?.id ?? null,
				threadId: threadRow.id,
				userId: connection.user_id,
				type: 'email_unknown_sender'
			});
			return;
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

			const created = await runAgent({
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
		const created = await runAgent({
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

const refreshAccessTokenIfNeeded = async (connection) => {
	let accessToken = connection.access_token;
	const expiresAt = new Date(connection.expires_at).getTime();
	const refreshNeeded = Number.isNaN(expiresAt) || expiresAt - Date.now() < 120000;

	if (!refreshNeeded) {
		return { accessToken, refreshed: false };
	}

	if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
		throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
	}

	const refreshBody = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		client_secret: GOOGLE_CLIENT_SECRET,
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
			return { accessToken: null, revoked: true };
		}
		throw new Error(detail);
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

	return { accessToken, refreshed: true };
};

export const handleGmailPubsub = async ({ body, runAgent }) => {
	const data = body?.message?.data;
	if (!data) {
		return { status: 400, body: { error: 'Missing Pub/Sub message' } };
	}

	const decoded = decodeBase64Url(data);
	const payload = JSON.parse(decoded);
	const emailAddress = payload.emailAddress;
	const historyId = payload.historyId;
	const normalizedEmail = emailAddress ? normalizeEmail(emailAddress) : null;

	if (!normalizedEmail || !historyId) {
		return { status: 400, body: { error: 'Invalid payload' } };
	}

	console.log('gmail-push received', {
		email: normalizedEmail,
		history_id: historyId
	});

	const { data: connection } = await supabase
		.from('gmail_connections')
		.select('*')
		.eq('email', normalizedEmail)
		.maybeSingle();

	if (!connection) {
		return { status: 200, body: { status: 'ignored' } };
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
		return { status: 200, body: { status: 'skip' } };
	}

	let accessToken = connection.access_token;
	try {
		const refreshResult = await refreshAccessTokenIfNeeded(connection);
		if (refreshResult?.revoked) {
			return { status: 200, body: { status: 'revoked' } };
		}
		accessToken = refreshResult.accessToken;
	} catch (err) {
		console.error('gmail-push refresh failed', err);
		return { status: 500, body: { error: err?.message ?? 'Token refresh failed' } };
	}

	if (!accessToken) {
		return { status: 200, body: { status: 'skip' } };
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
			return { status: 200, body: { status: 'reset' } };
		}
		console.error('gmail-push history error', err);
		throw err;
	}

	const historyItems = historyResponse.history ?? [];
	const messageIds = new Set();
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
		await processMessage({ connection, accessToken, message, runAgent });
	}

	console.log('gmail-push processed', {
		email: normalizedEmail,
		message_count: messageIds.size
	});

	const newHistoryId = historyResponse.historyId ?? historyId;
	await supabase.from('email_ingestion_state').upsert({
		user_id: connection.user_id,
		connection_id: connection.id,
		last_history_id: String(newHistoryId),
		updated_at: new Date().toISOString()
	});

	return { status: 200, body: { status: 'ok' } };
};
