// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

const _issuesStatusConfig = {
	in_progress: {
		id: 'in-progress',
		label: 'In Progress',
		statusClass: 'border-orange-500 text-orange-600'
	},
	todo: { id: 'todo', label: 'Todo', statusClass: 'border-neutral-500 text-neutral-700' },
	done: { id: 'done', label: 'Done', statusClass: 'border-emerald-500 text-emerald-700' }
};
const _issuesStatusOrder = ['todo', 'in_progress', 'done'];
const _allowedStatuses = new Set(_issuesStatusOrder);
const _normalizeStatus = (value) => {
	if (!value) return 'todo';
	const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
	if (normalized === 'in_progress') return 'in_progress';
	if (normalized === 'done' || normalized === 'completed' || normalized === 'complete')
		return 'done';
	if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
	return _allowedStatuses.has(normalized) ? normalized : 'todo';
};

export const loadIssuesData = async (
	workspaceId,
	userId,
	userRole,
	ownerPersonId,
	options = {}
) => {
	const includeSubIssues = options?.includeSubIssues !== false;
	const includeActivity = options?.includeActivity === true;
	const role = (userRole ?? '').toLowerCase();
	const isAssigneeScoped = role === 'member' || role === 'vendor';
	const isOwnerScoped = role === 'owner';

	let ownerUnitIds = [];
	if (isOwnerScoped && ownerPersonId) {
		const { data: ownerRecord } = await supabaseAdmin
			.from('owners')
			.select('id, owner_properties(property_id)')
			.eq('people_id', ownerPersonId)
			.eq('workspace_id', workspaceId)
			.maybeSingle();
		const propertyIds = (ownerRecord?.owner_properties ?? []).map((op) => op.property_id);
		if (propertyIds.length > 0) {
			const { data: unitRows } = await supabaseAdmin
				.from('units')
				.select('id')
				.in('property_id', propertyIds);
			ownerUnitIds = Array.from(new Set((unitRows ?? []).map((u) => u.id).filter(Boolean)));
		}
	}

	const buildIssuesQuery = () => {
		let query = supabaseAdmin
			.from('issues')
			.select(
				'id, name, description, status, urgent, parent_id, unit_id, property_id, issue_number, readable_id, assignee_id, vendor_id, source, agent_processed_at, created_at, updated_at'
			)
			.eq('workspace_id', workspaceId)
			.order('updated_at', { ascending: false });
		if (!includeSubIssues) {
			query = query.is('parent_id', null);
		}
		if (isAssigneeScoped) {
			query = query.eq('assignee_id', userId);
		}
		if (isOwnerScoped) {
			query = ownerUnitIds.length ? query.in('unit_id', ownerUnitIds) : query.eq('id', '__none__');
		}
		return query;
	};

	let { data: rawIssues } = await buildIssuesQuery();
	// Hide AppFolio issues that haven't been fully processed by the agent yet.
	// agent_processed_at is set after done() completes, so NULL means mid-flight or failed.
	let issues = (rawIssues ?? []).filter(
		(issue) => issue.source !== 'appfolio' || issue.agent_processed_at != null
	);

	if (!issues?.length) {
		const { data: fallbackUnits } = await supabaseAdmin
			.from('units')
			.select('id, properties!inner(workspace_id)')
			.eq('properties.workspace_id', workspaceId);
		const fallbackUnitIds = Array.from(
			new Set((fallbackUnits ?? []).map((u) => u.id).filter(Boolean))
		);
		if (fallbackUnitIds.length) {
			let fallbackQuery = supabaseAdmin
				.from('issues')
				.select(
					'id, name, description, status, urgent, parent_id, unit_id, property_id, issue_number, readable_id, assignee_id, vendor_id, source, agent_processed_at, created_at, updated_at'
				)
				.in('unit_id', fallbackUnitIds)
				.order('updated_at', { ascending: false });
			if (!includeSubIssues) {
				fallbackQuery = fallbackQuery.is('parent_id', null);
			}
			if (isAssigneeScoped) {
				fallbackQuery = fallbackQuery.eq('assignee_id', userId);
			}
			if (isOwnerScoped) {
				fallbackQuery = ownerUnitIds.length
					? fallbackQuery.in('unit_id', ownerUnitIds)
					: fallbackQuery.eq('id', '__none__');
			}
			const { data: fallbackIssues } = await fallbackQuery;
			issues = (fallbackIssues ?? []).filter(
				(issue) => issue.source !== 'appfolio' || issue.agent_processed_at != null
			);
		}
	}

	const unitIds = Array.from(new Set((issues ?? []).map((i) => i.unit_id).filter(Boolean)));
	const { data: units } = unitIds.length
		? await supabaseAdmin.from('units').select('id, name, property_id').in('id', unitIds)
		: { data: [] };
	const unitMap = new Map((units ?? []).map((u) => [u.id, u]));

	const propertyIds = Array.from(
		new Set([
			...(units ?? []).map((u) => u.property_id).filter(Boolean),
			...(issues ?? []).map((i) => i.property_id).filter(Boolean)
		])
	);
	const { data: properties } = propertyIds.length
		? await supabaseAdmin.from('properties').select('id, name').in('id', propertyIds)
		: { data: [] };
	const propertyMap = new Map((properties ?? []).map((p) => [p.id, p]));

	const latestActivityByIssue = new Map();
	const setLatestActivity = (id, value) => {
		if (!id || !value) return;
		const ts = new Date(value).getTime();
		if (!Number.isFinite(ts)) return;
		const prev = latestActivityByIssue.get(id) ?? 0;
		if (ts > prev) latestActivityByIssue.set(id, ts);
	};

	for (const issue of issues ?? []) {
		setLatestActivity(issue.id, issue.updated_at);
	}

	if (includeActivity && (issues ?? []).length) {
		const issueIds = (issues ?? []).map((issue) => issue.id).filter(Boolean);
		const [{ data: logs }, { data: drafts }] = await Promise.all([
			supabaseAdmin
				.from('activity_logs')
				.select('issue_id, created_at')
				.eq('workspace_id', workspaceId)
				.in('issue_id', issueIds),
			supabaseAdmin
				.from('drafts')
				.select('issue_id, updated_at')
				.eq('workspace_id', workspaceId)
				.in('issue_id', issueIds)
		]);
		for (const log of logs ?? []) {
			setLatestActivity(log.issue_id, log.created_at);
		}
		for (const draft of drafts ?? []) {
			setLatestActivity(draft.issue_id, draft.updated_at);
		}
	}

	const normalizedIssuesBase = (issues ?? []).map((issue) => {
		const unit = unitMap.get(issue.unit_id);
		const resolvedPropertyId = issue.property_id ?? unit?.property_id ?? null;
		const property = resolvedPropertyId ? propertyMap.get(resolvedPropertyId) : null;
		const status = _normalizeStatus(issue.status);
		const latestActivityAt = latestActivityByIssue.get(issue.id)
			? new Date(latestActivityByIssue.get(issue.id)).toISOString()
			: null;
		return {
			id: issue.id,
			issueId: issue.id,
			title: issue.name,
			name: issue.name,
			description: issue.description ?? '',
			urgent: issue.urgent ?? false,
			assignees: 0,
			assigneeId: issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? null,
			vendor_id: issue.vendor_id ?? null,
			property: property?.name ?? 'Unknown',
			propertyId: resolvedPropertyId,
			property_id: resolvedPropertyId,
			unit: unit?.name ?? 'Unknown',
			issueNumber: issue.issue_number ?? null,
			readableId: issue.readable_id ?? null,
			status,
			parentId: issue.parent_id ?? null,
			parent_id: issue.parent_id ?? null,
			created_at: issue.created_at ?? null,
			updated_at: issue.updated_at ?? null,
			latestActivityAt
		};
	});

	const issuesById = new Map(normalizedIssuesBase.map((i) => [i.id, i]));
	const resolveRoot = (issue) => {
		let current = issue;
		const visited = new Set();
		for (let i = 0; i < 20; i += 1) {
			if (!current?.id) return issue;
			if (!current.parentId) return current;
			if (visited.has(current.id)) return issue;
			visited.add(current.id);
			const parent = issuesById.get(current.parentId);
			if (!parent) return current;
			current = parent;
		}
		return issue;
	};

	// Root-level vendor assignment: store on root, but expose on every issue/subissue.
	const normalizedIssues = normalizedIssuesBase.map((issue) => {
		const root = resolveRoot(issue);
		const vendorId = root?.vendor_id ?? issue.vendor_id ?? null;
		return {
			...issue,
			vendorId,
			vendor_id: issue.vendor_id ?? null
		};
	});

	const vendorIds = Array.from(new Set(normalizedIssues.map((i) => i.vendorId).filter(Boolean)));
	const { data: vendors } = vendorIds.length
		? await supabaseAdmin.from('vendors').select('id, name, email').in('id', vendorIds)
		: { data: [] };
	const vendorMap = new Map((vendors ?? []).map((v) => [v.id, v]));
	for (const issue of normalizedIssues) {
		const vendor = issue.vendorId ? vendorMap.get(issue.vendorId) : null;
		issue.vendorName = vendor?.name ?? null;
		issue.vendorEmail = vendor?.email ?? null;
	}

	const issuesByIdFinal = new Map(normalizedIssues.map((i) => [i.id, i]));
	const childrenByParent = new Map();
	for (const issue of normalizedIssues) {
		if (!issue.parentId) continue;
		if (!childrenByParent.has(issue.parentId)) childrenByParent.set(issue.parentId, []);
		childrenByParent.get(issue.parentId).push(issue);
	}

	const topLevelIssues = normalizedIssues.filter(
		(i) => !i.parentId || !issuesByIdFinal.has(i.parentId)
	);

	const sectionBuckets = new Map(
		_issuesStatusOrder.map((status) => {
			const config = _issuesStatusConfig[status] ?? {
				id: status,
				label: status,
				statusClass: 'border-neutral-500 text-neutral-600'
			};
			return [status, { config, items: [] }];
		})
	);

	for (const issue of topLevelIssues) {
		const status = issue.status ?? 'todo';
		const bucket = sectionBuckets.get(status);
		if (!bucket) continue;
		const subIssues = (childrenByParent.get(issue.id) ?? [])
			.filter((child) => (child.status ?? 'todo') === status)
			.map((subIssue) => ({
				id: subIssue.id,
				issueId: subIssue.issueId,
				title: subIssue.title,
				parentTitle: issue.title,
				parentId: issue.id,
				parent_id: issue.id,
				urgent: subIssue.urgent ?? false,
				root_urgent: issue.urgent ?? false,
				vendorId: subIssue.vendorId ?? issue.vendorId ?? null,
				vendorName: subIssue.vendorName ?? issue.vendorName ?? null,
				property: subIssue.property,
				propertyId: subIssue.propertyId ?? subIssue.property_id ?? null,
				property_id: subIssue.property_id ?? subIssue.propertyId ?? null,
				unit: subIssue.unit,
				issueNumber: subIssue.issueNumber,
				readableId: subIssue.readableId,
				assignees: subIssue.assignees,
				assigneeId: subIssue.assigneeId ?? subIssue.assignee_id ?? null,
				assignee_id: subIssue.assignee_id ?? subIssue.assigneeId ?? null,
				created_at: subIssue.created_at ?? null,
				updated_at: subIssue.updated_at ?? null,
				latestActivityAt: subIssue.latestActivityAt ?? null
			}));
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId,
			title: issue.title,
			assignees: issue.assignees,
			assigneeId: issue.assigneeId ?? issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? issue.assigneeId ?? null,
			urgent: issue.urgent ?? false,
			vendorId: issue.vendorId ?? null,
			vendorName: issue.vendorName ?? null,
			property: issue.property,
			propertyId: issue.propertyId ?? issue.property_id ?? null,
			property_id: issue.property_id ?? issue.propertyId ?? null,
			unit: issue.unit,
			issueNumber: issue.issueNumber,
			readableId: issue.readableId,
			subIssues,
			created_at: issue.created_at ?? null,
			updated_at: issue.updated_at ?? null,
			latestActivityAt: issue.latestActivityAt ?? null
		});
	}

	for (const issue of normalizedIssues) {
		if (!issue.parentId) continue;
		const parent = issuesById.get(issue.parentId);
		if (!parent) continue;
		if ((parent.status ?? 'todo') === (issue.status ?? 'todo')) continue;
		const bucket = sectionBuckets.get(issue.status ?? 'todo');
		if (!bucket) continue;
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId,
			title: issue.title,
			assignees: issue.assignees,
			assigneeId: issue.assigneeId ?? issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? issue.assigneeId ?? null,
			urgent: issue.urgent ?? false,
			vendorId: issue.vendorId ?? null,
			vendorName: issue.vendorName ?? null,
			parentId: parent.id,
			parent_id: parent.id,
			root_urgent: parent.urgent ?? false,
			property: issue.property,
			propertyId: issue.propertyId ?? issue.property_id ?? null,
			property_id: issue.property_id ?? issue.propertyId ?? null,
			unit: issue.unit,
			issueNumber: issue.issueNumber,
			readableId: issue.readableId,
			parentTitle: parent.title,
			isSubIssue: true,
			subIssues: [],
			created_at: issue.created_at ?? null,
			updated_at: issue.updated_at ?? null,
			latestActivityAt: issue.latestActivityAt ?? null
		});
	}

	const sections = _issuesStatusOrder.map((status) => {
		const bucket = sectionBuckets.get(status);
		const config = bucket?.config ?? _issuesStatusConfig[status];
		const items = bucket?.items ?? [];
		return {
			id: config.id,
			label: config.label,
			count: items.length,
			statusClass: config.statusClass,
			items
		};
	});

	const filteredSections = sections.filter((s) => s.count > 0);

	const { data: assignee } = await supabaseAdmin
		.from('users')
		.select('id, name')
		.eq('id', userId)
		.maybeSingle();

	return { sections: filteredSections, issues: normalizedIssues, assignee, workspaceId };
};

export const loadIssueReadsData = async (workspaceId, userId, issueIds = []) => {
	if (!workspaceId || !userId || !issueIds?.length) return { issueReads: [] };
	const { data: issueReads } = await supabaseAdmin
		.from('issue_reads')
		.select('issue_id, last_seen_at')
		.eq('workspace_id', workspaceId)
		.eq('user_id', userId)
		.in('issue_id', issueIds);
	return { issueReads: issueReads ?? [] };
};

export const loadPoliciesData = async (workspaceId) => {
	if (!workspaceId) return { policies: [] };
	const { data: policies } = await supabaseAdmin
		.from('workspace_policies')
		.select('id, type, email, description, meta, created_at, created_by, users:created_by(name)')
		.eq('workspace_id', workspaceId)
		.order('created_at', { ascending: false });

	const normalized = (policies ?? []).map((policy) => ({
		id: policy.id,
		type: policy.type ?? 'urgency',
		email: policy.email ?? '',
		description: policy.description ?? '',
		meta: policy.meta ?? null,
		createdAt: policy.created_at ?? null,
		createdById: policy.created_by ?? null,
		createdByName: policy.users?.name ?? 'Unknown'
	}));

	return { policies: normalized };
};

const normalizeRecipientList = (value) => {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map((email) => String(email ?? '').trim()).filter(Boolean);
	}
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((email) => email.trim())
			.filter(Boolean);
	}
	return [];
};

const normalizeDraftRecipients = (draft) => {
	if (!draft) return draft;
	const normalized = normalizeRecipientList(draft.recipient_emails);
	if (!normalized.length && draft.recipient_email) {
		return { ...draft, recipient_emails: [draft.recipient_email] };
	}
	if (normalized.length && normalized !== draft.recipient_emails) {
		return { ...draft, recipient_emails: normalized };
	}
	return draft;
};

export const loadActivityData = async (workspaceId, issueIds = null) => {
	const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	if (Array.isArray(issueIds) && issueIds.length === 0) {
		return { messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] };
	}
	let threadIdToIssueId = new Map();
	let messages = [];
	let draftsResult = { data: [] };

	const baseMessagesQuery = () =>
		supabaseAdmin
			.from('messages')
			.select(
				'id, issue_id, thread_id, message, sender, subject, timestamp, direction, channel, metadata'
			)
			.eq('workspace_id', workspaceId)
			.gte('timestamp', cutoff)
			.order('timestamp', { ascending: true });

	let draftsQuery = supabaseAdmin
		.from('drafts')
		.select(
			'id, issue_id, message_id, sender_email, recipient_email, recipient_emails, subject, body, original_body, draft_diff, updated_at, channel'
		)
		.eq('workspace_id', workspaceId)
		.gte('updated_at', cutoff)
		.order('updated_at', { ascending: false });

	let threadInfoById = new Map();

	if (Array.isArray(issueIds)) {
		const { data: threads } = await supabaseAdmin
			.from('threads')
			.select('id, issue_id, participant_type, name')
			.eq('workspace_id', workspaceId)
			.in('issue_id', issueIds);
		const threadIds = (threads ?? []).map((thread) => thread.id).filter(Boolean);
		threadIdToIssueId = new Map(
			(threads ?? []).map((thread) => [thread.id, thread.issue_id]).filter(([, id]) => id)
		);
		threadInfoById = new Map(
			(threads ?? []).map((t) => [t.id, { participant_type: t.participant_type, name: t.name }])
		);

		const [byIssueResult, byThreadResult, nextDraftsResult] = await Promise.all([
			baseMessagesQuery().in('issue_id', issueIds),
			threadIds.length ? baseMessagesQuery().in('thread_id', threadIds) : { data: [] },
			draftsQuery.in('issue_id', issueIds)
		]);

		draftsResult = nextDraftsResult;
		const messageMap = new Map();
		for (const msg of [...(byIssueResult?.data ?? []), ...(byThreadResult?.data ?? [])]) {
			if (!msg?.id || messageMap.has(msg.id)) continue;
			const resolvedIssueId = msg.issue_id ?? threadIdToIssueId.get(msg.thread_id) ?? null;
			messageMap.set(msg.id, resolvedIssueId ? { ...msg, issue_id: resolvedIssueId } : msg);
		}
		messages = [...messageMap.values()].sort((a, b) => {
			const timeA = a?.timestamp ? new Date(a.timestamp).getTime() : 0;
			const timeB = b?.timestamp ? new Date(b.timestamp).getTime() : 0;
			return timeA - timeB;
		});
	} else {
		const [messagesResult, nextDraftsResult] = await Promise.all([
			baseMessagesQuery(),
			draftsQuery
		]);
		messages = messagesResult?.data ?? [];
		draftsResult = nextDraftsResult;
	}

	const messagesByIssue = messages.reduce((acc, m) => {
		const resolvedIssueId = m.issue_id ?? threadIdToIssueId.get(m.thread_id) ?? null;
		if (!resolvedIssueId) return acc;
		const threadInfo = m.thread_id ? threadInfoById.get(m.thread_id) : null;
		const enriched = {
			...m,
			issue_id: resolvedIssueId,
			_participant_type: m.metadata?.participant_type ?? threadInfo?.participant_type ?? null,
			_participant_name: threadInfo?.name ?? null
		};
		(acc[resolvedIssueId] ??= []).push(enriched);
		return acc;
	}, {});
	const normalizedDrafts = (draftsResult?.data ?? []).map((draft) =>
		normalizeDraftRecipients(draft)
	);
	const emailDraftsByMessageId = normalizedDrafts.reduce((acc, d) => {
		const key = d.message_id ?? d.id;
		if (key && !acc[key]) acc[key] = d;
		return acc;
	}, {});
	const draftIssueIds = [...new Set(normalizedDrafts.map((d) => d.issue_id).filter(Boolean))];
	return { messagesByIssue, emailDraftsByMessageId, draftIssueIds };
};

export const loadActivityLogsData = async (workspaceId, issueIds = null) => {
	const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	if (Array.isArray(issueIds) && issueIds.length === 0) {
		return { logsByIssue: {} };
	}
	let logsQuery = supabaseAdmin
		.from('activity_logs')
		.select(
			'id, issue_id, workspace_id, type, from_email, to_emails, subject, body, data, created_by, created_at'
		)
		.eq('workspace_id', workspaceId)
		.or(`created_at.gte.${cutoff},type.eq.issue_created`)
		.order('created_at', { ascending: true });
	if (Array.isArray(issueIds)) {
		logsQuery = logsQuery.in('issue_id', issueIds);
	}
	const { data: logs } = await logsQuery;
	const logsByIssue = (logs ?? []).reduce((acc, log) => {
		if (!log.issue_id) return acc;
		(acc[log.issue_id] ??= []).push(log);
		return acc;
	}, {});
	return { logsByIssue };
};

export const loadNotificationsData = async (workspaceId, userId) => {
	const [{ data: notifications }, { data: members }] = await Promise.all([
		supabaseAdmin
			.from('notifications')
			.select(
				`id, title, body, is_read, is_resolved, created_at, type, meta, requires_action,
        issues(id, name, status, issue_number, readable_id, units(name, properties(name)))`
			)
			.eq('workspace_id', workspaceId)
			.eq('user_id', userId)
			.order('created_at', { ascending: false }),
		supabaseAdmin
			.from('people')
			.select('user_id, role, users(name, id)')
			.eq('workspace_id', workspaceId)
			.in('role', ['admin', 'bedrock', 'member', 'owner', 'vendor'])
	]);
	return { notifications: notifications ?? [], members: members ?? [] };
};

export const loadPeopleMembers = async (workspaceId) => {
	const { data: members } = await supabaseAdmin
		.from('people')
		.select('user_id, role, users(name, id)')
		.eq('workspace_id', workspaceId)
		.in('role', ['admin', 'bedrock', 'member', 'owner', 'vendor']);
	return members ?? [];
};

export const loadVendors = async (workspaceId) => {
	let response = await supabaseAdmin
		.from('vendors')
		.select('id, name, email, trade, preference_index')
		.eq('workspace_id', workspaceId)
		.order('trade', { ascending: true })
		.order('preference_index', { ascending: true })
		.order('name', { ascending: true });
	if (response.error?.message?.includes('preference_index')) {
		response = await supabaseAdmin
			.from('vendors')
			.select('id, name, email, trade')
			.eq('workspace_id', workspaceId)
			.order('trade', { ascending: true })
			.order('name', { ascending: true });
	}
	return response.data ?? [];
};

export const loadPeople = async (workspaceId) => {
	const [{ data: people }, vendorResponse] = await Promise.all([
		supabaseAdmin
			.from('people')
			.select('id, name, email, role, trade, notes, pending, created_at, user_id')
			.eq('workspace_id', workspaceId)
			.order('name', { ascending: true }),
		supabaseAdmin
			.from('vendors')
			.select('id, name, email, trade, note, phone, created_at, preference_index')
			.eq('workspace_id', workspaceId)
			.order('trade', { ascending: true })
			.order('preference_index', { ascending: true })
			.order('name', { ascending: true })
	]);
	let vendorRows = vendorResponse.data;
	if (vendorResponse.error?.message?.includes('preference_index')) {
		const fallback = await supabaseAdmin
			.from('vendors')
			.select('id, name, email, trade, note, phone, created_at')
			.eq('workspace_id', workspaceId)
			.order('trade', { ascending: true })
			.order('name', { ascending: true });
		vendorRows = fallback.data;
	}
	const mergedVendors = (vendorRows ?? []).map((v) => ({
		id: v.id,
		name: v.name,
		email: v.email,
		role: 'vendor',
		trade: v.trade,
		notes: v.note,
		pending: false,
		created_at: v.created_at,
		user_id: null,
		preference_index: v.preference_index
	}));
	return [...(people ?? []), ...mergedVendors].sort((a, b) =>
		(a.name ?? '').localeCompare(b.name ?? '')
	);
};
