<script>
	// @ts-nocheck
	import { browser } from '$app/environment';
	import { goto, preloadData } from '$app/navigation';
	import { page } from '$app/stores';
	import { onDestroy } from 'svelte';

	import EmailMessageWithDraft from '$lib/components/EmailMessageWithDraft.svelte';
	import { pageReady } from '$lib/stores/pageReady';
	import { supabase } from '$lib/supabaseClient.js';

	export let data;

	$: role = (data?.role ?? '').toString().toLowerCase();
	$: canEditIssue = role === 'admin';

	if (!browser) {
		pageReady.set(false);
	}

	const statusConfig = {
		in_progress: {
			label: 'In Progress',
			statusClass: 'border-amber-500 text-amber-600'
		},
		todo: {
			label: 'Todo',
			statusClass: 'border-neutral-500 text-neutral-700'
		},
		done: {
			label: 'Done',
			statusClass: 'border-emerald-500 text-emerald-700'
		}
	};

	const roleLabels = {
		owner: 'Owner',
		admin: 'Admin',
		member: 'Member',
		vendor: 'Vendor'
	};

	const sortSubIssues = (items) => {
		if (!items?.length) return [];
		return [...items].sort((a, b) => {
			const numA = a?.issueNumber ?? Number.MAX_SAFE_INTEGER;
			const numB = b?.issueNumber ?? Number.MAX_SAFE_INTEGER;
			if (numA !== numB) return numA - numB;
			const nameA = (a?.name ?? '').toString();
			const nameB = (b?.name ?? '').toString();
			return nameA.localeCompare(nameB);
		});
	};

	// ── Local state from server data ────────────────────────────────────────────

	let issue = data.issue ?? null;
	let assignee = null;
	let issueAssigneeId = data.issue?.assignee_id ?? null;
	let commentBody = '';
	let commentTextarea;

	// ── Streaming resolution for secondary data ───────────────────────────────

	let _resolvedSubIssues = [];
	$: {
		if (data.subIssues instanceof Promise) {
			data.subIssues.then((d) => { _resolvedSubIssues = d ?? []; });
		} else {
			_resolvedSubIssues = data.subIssues ?? [];
		}
	}

	let _resolvedActivity = null;
	$: {
		if (data.activityData instanceof Promise) {
			_resolvedActivity = null;
			data.activityData.then((d) => { _resolvedActivity = d; });
		} else if (data.activityData) {
			_resolvedActivity = data.activityData;
		}
	}

	let _resolvedLogs = null;
	$: {
		if (data.activityLogsData instanceof Promise) {
			_resolvedLogs = null;
			data.activityLogsData.then((d) => { _resolvedLogs = d; });
		} else if (data.activityLogsData) {
			_resolvedLogs = data.activityLogsData;
		}
	}

	let _resolvedMembers = [];
	$: {
		if (data.members instanceof Promise) {
			data.members.then((m) => { _resolvedMembers = m ?? []; });
		} else {
			_resolvedMembers = data.members ?? [];
		}
	}

	let _resolvedVendors = [];
	$: {
		if (data.vendors instanceof Promise) {
			data.vendors.then((v) => { _resolvedVendors = v ?? []; });
		} else {
			_resolvedVendors = data.vendors ?? [];
		}
	}

	$: subIssues = _resolvedSubIssues;
	$: messagesByIssue = _resolvedActivity?.messagesByIssue ?? {};
	$: emailDraftsByMessageId = _resolvedActivity?.emailDraftsByMessageId ?? {};
	$: draftIssueIds = _resolvedActivity?.draftIssueIds ?? [];
	$: logsByIssue = _resolvedLogs?.logsByIssue ?? {};
	$: members = _resolvedMembers;
	$: vendors = _resolvedVendors;

	// Re-sync when route changes (navigation to a different issue) or after invalidation
	$: if (data.issue?.id && data.issue.id !== issue?.id) {
		issue = data.issue;
		issueAssigneeId = data.issue.assignee_id ?? null;
		assignee = null;
	}

	// ── Derived values ───────────────────────────────────────────────────────────

	$: issueId = issue?.id ?? null;
	$: workspaceSlug = $page.params.workspace;
	$: issueKey = $page.params.issue_id ?? '';
	$: issueNameSlug = $page.params.issue_name ?? '';

	$: issueName = issue?.name ?? '';
	$: issueDescription = issue?.description ?? '';
	$: statusKey = issue?.status ?? 'todo';
	$: statusMeta = statusConfig[statusKey] ?? statusConfig.todo;
	$: issueReadableId = issue?.readableId ?? issueKey;

	$: if (issue) pageReady.set(true);

	// ── Member resolution ────────────────────────────────────────────────────────

	$: assignmentPool = members
		.filter((m) => m?.user_id)
		.map((m) => ({
			...m,
			users: m.user_id ? { id: m.user_id, name: m.name ?? m.users?.name ?? 'User' } : m.users
		}));

	$: membersByUserId = assignmentPool.reduce((acc, member) => {
		if (!member?.user_id) return acc;
		acc[member.user_id] = member;
		return acc;
	}, {});

	$: membersReady = true;
	$: membersLoading = false;

	// Initialize assignee from member map when available
	$: if (!assignee && issueAssigneeId && membersByUserId[issueAssigneeId]) {
		assignee = normalizeAssignee(membersByUserId[issueAssigneeId]);
	} else if (!assignee && issueAssigneeId) {
		assignee = placeholderAssignee(issueAssigneeId);
	}

	$: assignableMembers = [...assignmentPool]
		.filter((member) => {
			const r = (member?.role ?? '').toLowerCase();
			return (r === 'admin' || r === 'member') && Boolean(member?.user_id);
		})
		.sort((a, b) => {
			const order = { admin: 0, member: 1 };
			const rA = (a?.role ?? '').toLowerCase();
			const rB = (b?.role ?? '').toLowerCase();
			const roleDiff = (order[rA] ?? 9) - (order[rB] ?? 9);
			if (roleDiff !== 0) return roleDiff;
			const nameA = (a?.users?.name ?? '').toString();
			const nameB = (b?.users?.name ?? '').toString();
			return nameA.localeCompare(nameB);
		});

	$: subIssuesWithAssignees = subIssues.map((subIssue) => {
		const assigneeId = subIssue?.assigneeId ?? subIssue?.assignee_id ?? null;
		const resolved =
			resolveAssigneeFromId(assigneeId, membersByUserId) ?? placeholderAssignee(assigneeId);
		return { ...subIssue, assignee: resolved };
	});

	$: assigneeName = assignee?.name ?? assignee?.users?.name ?? 'Unassigned';
	$: subIssueProgress = `${subIssues.filter((item) => item.status === 'done').length}/${subIssues.length}`;

	// ── Navigation (prev/next removed — no issuesCache) ─────────────────────────

	$: prevIssue = null;
	$: nextIssue = null;
	$: currentIndex = -1;
	$: totalIssues = 0;

	// ── Activity derived ─────────────────────────────────────────────────────────

	$: draftsByIssue = Object.values(emailDraftsByMessageId ?? {}).reduce((acc, draft) => {
		if (!draft?.issue_id) return acc;
		if (!acc[draft.issue_id]) acc[draft.issue_id] = [];
		acc[draft.issue_id].push(draft);
		return acc;
	}, {});

	$: hasActivity =
		subIssues.some((item) => {
			const messages = messagesByIssue[item.id] ?? [];
			const hasDraft = draftIssueIds.includes(item.id);
			const hasLogs = (logsByIssue[item.id] ?? []).length > 0;
			return messages.length || hasDraft || hasLogs;
		}) ||
		(messagesByIssue[issueId]?.length ?? 0) > 0 ||
		(draftsByIssue[issueId]?.length ?? 0) > 0 ||
		(logsByIssue[issueId]?.length ?? 0) > 0;

	$: replyDraftsByIssue = Object.values(draftsByIssue ?? {}).reduce((acc, drafts) => {
		(drafts ?? []).forEach((draft) => {
			if (!draft?.issue_id || !draft?.message_id) return;
			if (!acc[draft.issue_id]) acc[draft.issue_id] = [];
			acc[draft.issue_id].push(draft);
		});
		return acc;
	}, {});

	$: newDraftsByIssue = Object.values(draftsByIssue ?? {}).reduce((acc, drafts) => {
		(drafts ?? []).forEach((draft) => {
			if (!draft?.issue_id || draft?.message_id) return;
			if (!acc[draft.issue_id]) acc[draft.issue_id] = [];
			acc[draft.issue_id].push(draft);
		});
		return acc;
	}, {});


	// ── Local mutation helpers ───────────────────────────────────────────────────

	function applyActivityLogDelta(log) {
		if (!log?.issue_id) return;
		const list = logsByIssue[log.issue_id] ?? [];
		const idx = list.findIndex((l) => l.id === log.id);
		const updated =
			idx >= 0 ? [...list.slice(0, idx), log, ...list.slice(idx + 1)] : [...list, log];
		logsByIssue = { ...logsByIssue, [log.issue_id]: updated };
	}

	function removeActivityLogFromCache(log) {
		if (!log?.id || !log?.issue_id) return;
		const list = logsByIssue[log.issue_id] ?? [];
		logsByIssue = { ...logsByIssue, [log.issue_id]: list.filter((l) => l.id !== log.id) };
	}

	function applyMessageDelta(msg) {
		if (!msg?.issue_id) return;
		const list = messagesByIssue[msg.issue_id] ?? [];
		const idx = list.findIndex((m) => m.id === msg.id);
		const updated =
			idx >= 0 ? [...list.slice(0, idx), msg, ...list.slice(idx + 1)] : [...list, msg];
		messagesByIssue = { ...messagesByIssue, [msg.issue_id]: updated };
	}

	function removeMessageFromCache(msg) {
		if (!msg?.id || !msg?.issue_id) return;
		const list = messagesByIssue[msg.issue_id] ?? [];
		messagesByIssue = { ...messagesByIssue, [msg.issue_id]: list.filter((m) => m.id !== msg.id) };
	}

	function applyDraftDelta(draft) {
		if (!draft) return;
		const key = draft.message_id ?? draft.id;
		if (!key) return;
		emailDraftsByMessageId = { ...emailDraftsByMessageId, [key]: draft };
		if (draft.issue_id && !draftIssueIds.includes(draft.issue_id)) {
			draftIssueIds = [...draftIssueIds, draft.issue_id];
		}
	}

	function removeDraftFromCache(draft) {
		if (!draft) return;
		const key = draft.message_id ?? draft.id;
		if (!key) return;
		const { [key]: _, ...rest } = emailDraftsByMessageId;
		emailDraftsByMessageId = rest;
	}

	const upsertMessage = applyMessageDelta;
	const removeMessage = removeMessageFromCache;
	const upsertDraft = applyDraftDelta;
	const removeDraft = removeDraftFromCache;

	// ── Activity log helpers ─────────────────────────────────────────────────────

	const getStatusRingClassFromLog = (log) => {
		const nextStatus = log?.data?.to ?? null;
		if (!nextStatus) return 'border-neutral-400';
		const statusClass = statusConfig[nextStatus]?.statusClass ?? '';
		const match = statusClass.match(/border-[^\s]+/g) ?? [];
		return match[0] ?? 'border-neutral-400';
	};

	const ACTIVITY_LOG_WINDOW_MS = 60 * 60 * 1000;

	const getLatestLogForIssue = (id, options = {}) => {
		const list = logsByIssue[id] ?? [];
		const ignoreTypes = new Set(options.ignoreTypes ?? []);
		if (!list.length) return null;
		return list.reduce((latest, entry) => {
			if (ignoreTypes.has(entry?.type)) return latest;
			if (!latest) return entry;
			const latestTime = new Date(latest.created_at ?? 0).getTime();
			const entryTime = new Date(entry.created_at ?? 0).getTime();
			return entryTime >= latestTime ? entry : latest;
		}, null);
	};

	const upsertIssueActivityLog = async ({ id, type, fromValue, toValue }) => {
		if (!id) return;
		const workspaceId = data?.workspace?.id ?? null;
		const userId = data?.userId ?? null;
		if (!workspaceId || !userId) return;

		const lastLog = getLatestLogForIssue(id, { ignoreTypes: ['comment'] });
		const logList = logsByIssue[id] ?? [];
		const lastAssigneeLog = [...logList]
			.reverse()
			.find((entry) => entry?.type === 'assignee_change');
		const lastData = lastAssigneeLog?.data ?? {};
		const lastFrom = Object.prototype.hasOwnProperty.call(lastData, 'from') ? lastData.from : null;
		const lastTo = Object.prototype.hasOwnProperty.call(lastData, 'to') ? lastData.to : null;
		const nowIso = new Date().toISOString();
		const lastCreatedAt = lastAssigneeLog?.created_at
			? new Date(lastAssigneeLog.created_at).getTime()
			: 0;
		const isWithinWindow = Date.now() - lastCreatedAt <= ACTIVITY_LOG_WINDOW_MS;
		const shouldUpdate =
			lastLog && lastLog.type === type && lastLog.created_by === userId && isWithinWindow;
		const lastAssigneeIndex = lastAssigneeLog
			? logList.findIndex((entry) => entry?.id === lastAssigneeLog.id)
			: -1;
		const hasCommentAfterLastAssignee =
			lastAssigneeIndex >= 0 &&
			logList.slice(lastAssigneeIndex + 1).some((entry) => entry?.type === 'comment');

		const isRevertLog =
			type === 'assignee_change' &&
			lastAssigneeLog &&
			lastAssigneeLog.created_by === userId &&
			lastTo === null &&
			lastFrom === (toValue ?? null) &&
			isWithinWindow &&
			!hasCommentAfterLastAssignee;

		const payloadData = {
			from: fromValue ?? null,
			to: toValue ?? null
		};

		if (isRevertLog) {
			removeActivityLogFromCache(lastAssigneeLog);
			await supabase.from('activity_logs').delete().eq('id', lastAssigneeLog.id);
			return;
		}

		if (shouldUpdate) {
			const optimistic = {
				...lastLog,
				issue_id: id,
				workspace_id: workspaceId,
				type,
				data: payloadData,
				created_by: userId,
				created_at: nowIso,
				updated_at: nowIso
			};
			applyActivityLogDelta(optimistic);
			const { data: updated, error } = await supabase
				.from('activity_logs')
				.update({ data: payloadData, created_at: nowIso, updated_at: nowIso })
				.eq('id', lastLog.id)
				.select('id, issue_id, workspace_id, type, body, data, created_by, created_at')
				.single();
			if (error || !updated?.id) {
				applyActivityLogDelta(lastLog);
				return;
			}
			applyActivityLogDelta(updated);
			return;
		}

		const tempId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const optimistic = {
			id: tempId,
			issue_id: id,
			workspace_id: workspaceId,
			type,
			data: payloadData,
			created_by: userId,
			created_at: nowIso
		};
		applyActivityLogDelta(optimistic);

		const { data: created, error } = await supabase
			.from('activity_logs')
			.insert({
				workspace_id: workspaceId,
				issue_id: id,
				type,
				data: payloadData,
				created_by: userId
			})
			.select('id, issue_id, workspace_id, type, body, data, created_by, created_at')
			.single();

		if (error || !created?.id) {
			removeActivityLogFromCache(optimistic);
			return;
		}

		removeActivityLogFromCache(optimistic);
		applyActivityLogDelta(created);
	};

	// ── Comment handling ─────────────────────────────────────────────────────────

	const handleCommentSend = async () => {
		const trimmed = commentBody.trim();
		if (!trimmed || !issueId) return;
		const tempId = `local-${Date.now()}`;
		const optimisticLog = {
			id: tempId,
			issue_id: issueId,
			type: 'comment',
			body: trimmed,
			created_by: data?.userId ?? null,
			created_at: new Date().toISOString()
		};
		applyActivityLogDelta(optimisticLog);
		commentBody = '';
		if (commentTextarea) {
			commentTextarea.style.height = 'auto';
		}

		const workspaceId = data?.workspace?.id ?? null;
		if (!workspaceId || !data?.userId) {
			removeActivityLogFromCache(optimisticLog);
			return;
		}

		const { data: created, error } = await supabase
			.from('activity_logs')
			.insert({
				workspace_id: workspaceId,
				issue_id: issueId,
				type: 'comment',
				body: trimmed,
				created_by: data.userId
			})
			.select('id, issue_id, workspace_id, type, body, data, created_by, created_at')
			.single();

		if (error || !created?.id) {
			removeActivityLogFromCache(optimisticLog);
			return;
		}

		removeActivityLogFromCache(optimisticLog);
		applyActivityLogDelta(created);

		if (/@bedrock/i.test(trimmed)) {
			fetch('/api/agent', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ issue_id: issueId ?? issueKey, comment: trimmed })
			}).catch(() => null);
		}
	};

	const resizeCommentTextarea = () => {
		if (!commentTextarea) return;
		commentTextarea.style.height = 'auto';
		commentTextarea.style.height = `${commentTextarea.scrollHeight}px`;
	};

	// ── Status and assignee changes ──────────────────────────────────────────────

	const statusCycle = ['todo', 'in_progress', 'done'];

	const handleStatusChange = async (newStatus) => {
		if (!canEditIssue) return;
		const prevStatus = statusKey;
		issue = { ...issue, status: newStatus };

		const { error } = await supabase.from('issues').update({ status: newStatus }).eq('id', issueId);

		if (error) {
			issue = { ...issue, status: prevStatus };
			return;
		}

		upsertIssueActivityLog({
			id: issueId,
			type: 'status_change',
			fromValue: prevStatus,
			toValue: newStatus
		});
	};

	let statusOpen = false;
	let assigneeOpen = false;

	const handleAssigneeSelect = async (member) => {
		if (!canEditIssue) return;
		if (!issueId) return;
		const nextId = member?.user_id ?? null;
		const currentId = assignee?.id ?? null;
		if (nextId === currentId) {
			assigneeOpen = false;
			return;
		}

		const nextAssignee = normalizeAssignee(member);
		const prevAssignee = assignee;
		const prevAssigneeId = issueAssigneeId;
		assignee = nextAssignee;
		issueAssigneeId = nextId;
		assigneeOpen = false;

		const { error } = await supabase
			.from('issues')
			.update({ assignee_id: nextId })
			.eq('id', issueId);

		if (error) {
			assignee = prevAssignee;
			issueAssigneeId = prevAssigneeId;
			return;
		}

		upsertIssueActivityLog({
			id: issueId,
			type: 'assignee_change',
			fromValue: prevAssigneeId,
			toValue: nextId
		});
	};

	// ── Utility functions ────────────────────────────────────────────────────────

	const normalizeAssignee = (member) => {
		if (!member) return null;
		const id = member.user_id ?? member?.users?.id ?? null;
		return {
			id,
			user_id: id,
			name: member?.users?.name ?? member?.name ?? null,
			users: member?.users ?? null
		};
	};

	const resolveAssigneeFromId = (assigneeId, memberMap) =>
		assigneeId && memberMap[assigneeId] ? normalizeAssignee(memberMap[assigneeId]) : null;

	const placeholderAssignee = (assigneeId) =>
		assigneeId ? { id: assigneeId, user_id: assigneeId, name: 'Assigned', users: null } : null;

	const getMemberAvatar = (member) => {
		const name = member?.users?.name ?? member?.name ?? 'User';
		const seed = member?.user_id ?? member?.users?.id ?? name;
		const initial = (name ?? 'U').toString().trim().charAt(0).toUpperCase() || 'U';
		const color = getAvatarColor(seed);
		return { name, initial, color };
	};

	const getAssigneeAvatar = (nextAssignee) => {
		const name = nextAssignee?.name ?? nextAssignee?.users?.name ?? 'User';
		const seed = nextAssignee?.user_id ?? nextAssignee?.id ?? name;
		const initial = (name ?? 'U').toString().trim().charAt(0).toUpperCase() || 'U';
		const color = getAvatarColor(seed);
		return { name, initial, color };
	};

	const avatarPalette = [
		'bg-amber-200',
		'bg-blue-200',
		'bg-emerald-200',
		'bg-rose-200',
		'bg-indigo-200',
		'bg-teal-200',
		'bg-orange-200',
		'bg-sky-200'
	];

	const getAvatarColor = (seed) => {
		if (!seed) return 'bg-neutral-200';
		const value = seed.toString();
		let hash = 0;
		for (let i = 0; i < value.length; i += 1) {
			hash = (hash * 31 + value.charCodeAt(i)) % avatarPalette.length;
		}
		return avatarPalette[hash] ?? 'bg-neutral-200';
	};

	const getCommentAuthor = (log) => {
		if (!log?.created_by) {
			return { name: 'Bedrock', initial: 'B', color: 'bg-neutral-800 text-white' };
		}
		const member = membersByUserId[log.created_by] ?? null;
		const name = member?.users?.name ?? member?.name ?? 'User';
		const initial = (name ?? 'U').toString().trim().charAt(0).toUpperCase() || 'U';
		const color = getAvatarColor(log.created_by ?? name);
		return { name, initial, color };
	};

	const getActivityActor = (log) => getCommentAuthor(log);

	const getAssigneeNameFromLog = (log) => {
		const d = log?.data ?? {};
		const hasTo = Object.prototype.hasOwnProperty.call(d, 'to');
		const targetId = hasTo ? d.to : (d.assignee_id ?? null);
		if (!targetId) return 'Unassigned';
		const member = membersByUserId[targetId];
		return member?.users?.name ?? member?.name ?? 'Unassigned';
	};

	const getStatusLabelFromLog = (log) => {
		const nextStatus = log?.data?.to ?? null;
		if (!nextStatus) return 'Unknown';
		return (statusConfig[nextStatus]?.label ?? nextStatus).toString();
	};

	const collectMessagesForIssue = (id) => {
		const messages = messagesByIssue[id] ?? [];
		return [...messages].sort((a, b) => {
			const timeA = a?.timestamp ? new Date(a.timestamp).getTime() : 0;
			const timeB = b?.timestamp ? new Date(b.timestamp).getTime() : 0;
			return timeA - timeB;
		});
	};

	const formatTimestamp = (value) => {
		if (!value) return '';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '';
		return date.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	};

	const getThreadSubject = (id) => {
		if (!id) return '';
		const messages = collectMessagesForIssue(id);
		const messageSubject = messages.find((msg) => msg?.subject)?.subject ?? '';
		const draftSubject = (draftsByIssue[id] ?? []).find((draft) => draft?.subject)?.subject ?? '';
		return messageSubject || draftSubject || '';
	};

	let subIssuesOpen = true;
	let activityOpen = {};
	const toggleActivity = (id) => {
		activityOpen = { ...activityOpen, [id]: !(activityOpen[id] ?? true) };
	};

	const slugify = (value) =>
		(value ?? '')
			.toString()
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');

	const getIssueHref = (item) => {
		if (!item) return undefined;
		const slug = slugify(item.title);
		const readableId = item.readableId;
		if (!readableId) return undefined;
		return `/${$page.params.workspace}/issue/${readableId}/${slug}`;
	};

	const getSubIssueHref = (subIssue) => {
		if (!subIssue) return undefined;
		const readableId = subIssue.readableId;
		if (!readableId) return undefined;
		const slug = slugify(subIssue.name);
		const fromId = issueReadableId ?? issueKey;
		const fromSlug = issueNameSlug;
		const fromTitle = encodeURIComponent(issueName);
		return `/${$page.params.workspace}/issue/${readableId}/${slug}?fromIssueId=${fromId}&fromIssueSlug=${fromSlug}&fromIssueTitle=${fromTitle}`;
	};

	const copyIssueLink = async () => {
		if (!browser) return;
		const link = $page?.url?.href ?? '';
		if (!link) return;
		try {
			await navigator.clipboard?.writeText(link);
		} catch (err) {
			const textarea = document.createElement('textarea');
			textarea.value = link;
			textarea.setAttribute('readonly', '');
			textarea.style.position = 'absolute';
			textarea.style.left = '-9999px';
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand('copy');
			document.body.removeChild(textarea);
		}
	};

	// ── Realtime channels ────────────────────────────────────────────────────────

	let _subIssueChannel = null;

	$: if (browser && issueId) {
		if (_subIssueChannel) supabase.removeChannel(_subIssueChannel);
		_subIssueChannel = supabase
			.channel(`subissues-${issueId}`)
			.on(
				'postgres_changes',
				{ event: 'INSERT', schema: 'public', table: 'issues', filter: `parent_id=eq.${issueId}` },
				async ({ new: newSub }) => {
					const sub = {
						id: newSub.id,
						name: newSub.name,
						status: newSub.status,
						assigneeId: newSub.assignee_id ?? null,
						assignee_id: newSub.assignee_id ?? null,
						parent_id: issueId,
						issueNumber: newSub.issue_number ?? null,
						readableId: newSub.readable_id ?? null
					};
					if (!subIssues.some((s) => s.id === sub.id)) {
						subIssues = sortSubIssues([...subIssues, sub]);

						// Catch-up: fetch any messages/drafts/logs written before the channel subscribes
						const [{ data: msgs }, { data: drafts }] = await Promise.all([
							supabase
								.from('messages')
								.select('id, issue_id, message, sender, subject, timestamp, direction, channel')
								.eq('issue_id', newSub.id),
							supabase
								.from('email_drafts')
								.select(
									'id, issue_id, message_id, sender_email, recipient_email, recipient_emails, subject, body, updated_at'
								)
								.eq('issue_id', newSub.id)
						]);
						for (const msg of msgs ?? []) applyMessageDelta(msg);
						for (const draft of drafts ?? []) applyDraftDelta(draft);

						const { data: logs } = await supabase
							.from('activity_logs')
							.select(
								'id, issue_id, type, from_email, to_emails, subject, body, data, created_by, created_at'
							)
							.eq('issue_id', newSub.id);
						for (const log of logs ?? []) applyActivityLogDelta(log);
					}
				}
			)
			.subscribe();
	}

	const channelMap = new Map();

	const syncRealtimeChannels = (issueIds) => {
		const nextIds = new Set(issueIds.filter(Boolean));
		for (const [id, channel] of channelMap.entries()) {
			if (!nextIds.has(id)) {
				supabase.removeChannel(channel);
				channelMap.delete(id);
			}
		}

		for (const id of nextIds) {
			if (channelMap.has(id)) continue;
			const channel = supabase
				.channel(`issue-activity-${id}`)
				.on(
					'postgres_changes',
					{ event: '*', schema: 'public', table: 'messages', filter: `issue_id=eq.${id}` },
					(payload) => {
						if (payload.eventType === 'DELETE') {
							removeMessage(payload.old);
						} else {
							upsertMessage(payload.new);
						}
					}
				)
				.on(
					'postgres_changes',
					{ event: '*', schema: 'public', table: 'email_drafts', filter: `issue_id=eq.${id}` },
					(payload) => {
						if (payload.eventType === 'DELETE') {
							removeDraft(payload.old);
						} else {
							upsertDraft(payload.new);
						}
					}
				)
				.subscribe();

			channelMap.set(id, channel);
		}
	};

	$: if (browser && issueId) {
		const ids = [issueId, ...subIssues.map((item) => item.id)];
		syncRealtimeChannels(ids);
	}

	onDestroy(() => {
		for (const channel of channelMap.values()) supabase.removeChannel(channel);
		channelMap.clear();
		if (_subIssueChannel) supabase.removeChannel(_subIssueChannel);
		pageReady.set(true);
	});

	// ── Navigation ───────────────────────────────────────────────────────────────

	$: fromParam = $page.url.searchParams.get('from');
	$: fromIssueId = $page.url.searchParams.get('fromIssueId');
	$: fromIssueSlug = $page.url.searchParams.get('fromIssueSlug');
	$: fromIssueTitle = $page.url.searchParams.get('fromIssueTitle');

	$: backHref = fromIssueId
		? `/${$page.params.workspace}/issue/${fromIssueId}/${fromIssueSlug}`
		: fromParam === 'inbox'
			? `/${$page.params.workspace}/inbox`
			: `/${$page.params.workspace}/my-issues`;

	$: backLabel = fromIssueId
		? (fromIssueTitle ?? 'Parent issue')
		: fromParam === 'inbox'
			? 'Inbox'
			: 'My issues';

	$: if (browser && fromIssueId && backHref) {
		preloadData(backHref);
	}

	function onKeydown(e) {
		if (e.key !== 'Escape') return;
		if (document.querySelector('[role="dialog"]')) return;
		goto(backHref);
	}

	function onWindowClick() {
		if (statusOpen) statusOpen = false;
		if (assigneeOpen) assigneeOpen = false;
	}
</script>

<svelte:window on:keydown={onKeydown} on:click={onWindowClick} />

{#if issue}
	<div class="flex h-full">
		<div class="flex min-h-0 min-w-0 flex-1 flex-col">
			<div
				class="flex items-center justify-between border-b border-neutral-200 px-6 py-2 text-sm text-neutral-600"
			>
				<div
					class="flex items-center gap-2 transition-opacity duration-150"
					class:opacity-0={!$pageReady}
				>
					<a href={backHref} class="text-neutral-700 hover:underline">{backLabel}</a>
					<span class="text-neutral-300">›</span>
					<span class={`h-3 w-3 rounded-full border ${statusMeta.statusClass}`}></span>
					<span class="text-neutral-500">{issueName}</span>
				</div>
				<div
					class="flex items-center gap-2 transition-opacity duration-150"
					class:opacity-0={!$pageReady}
				>
					{#if totalIssues > 0 && currentIndex >= 0}
						<span class="text-xs text-neutral-500">{currentIndex + 1} / {totalIssues}</span>
					{/if}
					<a
						href={nextIssue ? getIssueHref(nextIssue) : undefined}
						class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100"
						class:pointer-events-none={!nextIssue}
						class:opacity-40={!nextIssue}
						aria-disabled={!nextIssue}
						aria-label="Next issue"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							fill="currentColor"
							viewBox="0 0 16 16"
						>
							<path
								d="M8 11.5a.5.5 0 0 1-.354-.146l-4-4a.5.5 0 1 1 .708-.708L8 10.293l3.646-3.647a.5.5 0 0 1 .708.708l-4 4A.5.5 0 0 1 8 11.5"
							/>
						</svg>
					</a>
					<a
						href={prevIssue ? getIssueHref(prevIssue) : undefined}
						class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100"
						class:pointer-events-none={!prevIssue}
						class:opacity-40={!prevIssue}
						aria-disabled={!prevIssue}
						aria-label="Previous issue"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							fill="currentColor"
							viewBox="0 0 16 16"
						>
							<path
								d="M8 4.5a.5.5 0 0 1 .354.146l4 4a.5.5 0 1 1-.708.708L8 5.707l-3.646 3.647a.5.5 0 0 1-.708-.708l4-4A.5.5 0 0 1 8 4.5"
							/>
						</svg>
					</a>
				</div>
			</div>

			<div
				class="flex-1 overflow-y-auto px-10 pt-8 pb-20 transition-opacity duration-200"
				class:opacity-0={!$pageReady}
			>
				<div class="flex flex-wrap items-start justify-between gap-6">
					<div class="min-w-0">
						<h1 class="text-2xl font-semibold text-neutral-900">{issueName}</h1>
						<div class="mt-2 text-sm text-neutral-500">
							{issueDescription || 'Add description...'}
						</div>
					</div>
					<div></div>
				</div>
				<div class="mt-6"></div>

				{#if subIssues.length}
					<div class="mt-8">
						<div class="flex items-center gap-2 text-sm text-neutral-600">
							<button
								type="button"
								class="flex items-center gap-2 rounded-md px-1.5 py-1 transition hover:bg-neutral-100"
								on:click={() => (subIssuesOpen = !subIssuesOpen)}
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="14"
									height="14"
									fill="currentColor"
									class="text-neutral-400 transition-transform duration-200"
									class:rotate-[-90deg]={!subIssuesOpen}
									viewBox="0 0 16 16"
								>
									<path
										d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
									/>
								</svg>
								<span class="text-neutral-700">Sub-issues</span>
							</button>
							<span class="text-neutral-400">{subIssueProgress}</span>
						</div>
						<div
							class="grid transition-[grid-template-rows] duration-150 ease-in-out"
							style:grid-template-rows={subIssuesOpen ? '1fr' : '0fr'}
						>
							<div class="overflow-hidden">
								<div class="mt-3">
									{#each subIssuesWithAssignees as subIssue}
										<a
											href={getSubIssueHref(subIssue)}
											class="flex items-center justify-between px-3 py-3 text-sm transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-200 focus-visible:outline-none"
										>
											<div class="flex items-center gap-3">
												<span class="h-4 w-4 rounded-full border border-neutral-300"></span>
												<span class="text-neutral-800">{subIssue.name}</span>
											</div>
											{#if subIssue.assignee}
												<div
													class={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${getAssigneeAvatar(subIssue.assignee).color}`}
													aria-label={getAssigneeAvatar(subIssue.assignee).name}
												>
													{getAssigneeAvatar(subIssue.assignee).initial}
												</div>
											{:else}
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="16"
													height="16"
													fill="currentColor"
													class="text-neutral-400"
													viewBox="0 0 16 16"
												>
													<path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0" />
													<path
														fill-rule="evenodd"
														d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1"
													/>
												</svg>
											{/if}
										</a>
									{/each}
								</div>
							</div>
						</div>
					</div>
				{/if}

				<div class="mt-8 border-t border-neutral-200 pt-6">
					<div class="flex items-center justify-between">
						<h2 class="text-base font-semibold text-neutral-800">Activity</h2>
						<div class="text-sm text-neutral-400">Unsubscribe</div>
					</div>
					{#if _resolvedActivity === null}
						<div class="mt-4 space-y-3">
							{#each { length: 3 } as _}
								<div class="flex items-start gap-3">
									<div class="skeleton mt-0.5 h-8 w-8 flex-shrink-0 rounded-full"></div>
									<div class="flex-1 space-y-2 pt-1">
										<div class="skeleton h-3 w-1/3"></div>
										<div class="skeleton h-3 w-2/3"></div>
									</div>
								</div>
							{/each}
						</div>
					{:else if !hasActivity}
						<div class="mt-4 text-sm text-neutral-500">No activity yet.</div>
					{:else}
						<div class="mt-4 space-y-4 text-sm">
							{#if (messagesByIssue[issueId]?.length ?? 0) > 0 || (draftsByIssue[issueId] ?? []).some((d) => !(messagesByIssue[issueId] ?? []).some((m) => m.id === d.message_id))}
								{#if (messagesByIssue[issueId]?.length ?? 0) > 0 || (replyDraftsByIssue[issueId]?.length ?? 0) > 0}
									<div class="space-y-3">
										{#if getThreadSubject(issueId)}
											<div class="flex items-center gap-3 px-1">
												<div
													class="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-100 bg-white"
												>
													<svg
														width="18"
														height="18"
														viewBox="0 0 32 32"
														fill="none"
														xmlns="http://www.w3.org/2000/svg"
													>
														<path
															d="M2 11.9556C2 8.47078 2 6.7284 2.67818 5.39739C3.27473 4.22661 4.22661 3.27473 5.39739 2.67818C6.7284 2 8.47078 2 11.9556 2H20.0444C23.5292 2 25.2716 2 26.6026 2.67818C27.7734 3.27473 28.7253 4.22661 29.3218 5.39739C30 6.7284 30 8.47078 30 11.9556V20.0444C30 23.5292 30 25.2716 29.3218 26.6026C28.7253 27.7734 27.7734 28.7253 26.6026 29.3218C25.2716 30 23.5292 30 20.0444 30H11.9556C8.47078 30 6.7284 30 5.39739 29.3218C4.22661 28.7253 3.27473 27.7734 2.67818 26.6026C2 25.2716 2 23.5292 2 20.0444V11.9556Z"
															fill="white"
														/>
														<path
															d="M22.0515 8.52295L16.0644 13.1954L9.94043 8.52295V8.52421L9.94783 8.53053V15.0732L15.9954 19.8466L22.0515 15.2575V8.52295Z"
															fill="#EA4335"
														/>
														<path
															d="M23.6231 7.38639L22.0508 8.52292V15.2575L26.9983 11.459V9.17074C26.9983 9.17074 26.3978 5.90258 23.6231 7.38639Z"
															fill="#FBBC05"
														/>
														<path
															d="M22.0508 15.2575V23.9924H25.8428C25.8428 23.9924 26.9219 23.8813 26.9995 22.6513V11.459L22.0508 15.2575Z"
															fill="#34A853"
														/>
														<path
															d="M9.94811 24.0001V15.0732L9.94043 15.0669L9.94811 24.0001Z"
															fill="#C5221F"
														/>
														<path
															d="M9.94014 8.52404L8.37646 7.39382C5.60179 5.91001 5 9.17692 5 9.17692V11.4651L9.94014 15.0667V8.52404Z"
															fill="#C5221F"
														/>
														<path
															d="M9.94043 8.52441V15.0671L9.94811 15.0734V8.53073L9.94043 8.52441Z"
															fill="#C5221F"
														/>
														<path
															d="M5 11.4668V22.6591C5.07646 23.8904 6.15673 24.0003 6.15673 24.0003H9.94877L9.94014 15.0671L5 11.4668Z"
															fill="#4285F4"
														/>
													</svg>
												</div>
												<h3 class="text-base font-semibold text-neutral-900">
													{getThreadSubject(issueId)}
												</h3>
											</div>
										{:else if (replyDraftsByIssue[issueId]?.length ?? 0) > 0}
											<div class="flex items-center gap-3 px-1">
												<div
													class="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-100 bg-white"
												>
													<svg
														width="18"
														height="18"
														viewBox="0 0 16 16"
														fill="currentColor"
														class="text-neutral-500"
													>
														<path
															d="M8 3a5 5 0 1 0 4.546 2.916.5.5 0 0 0-.908-.418A4 4 0 1 1 8 4.5V6a.5.5 0 0 0 .854.354l2-2a.5.5 0 0 0 0-.708l-2-2A.5.5 0 0 0 8 2v1z"
														/>
													</svg>
												</div>
												<h3 class="text-base font-semibold text-neutral-900">Draft reply</h3>
											</div>
										{/if}
										<div class="space-y-3 pl-11">
											{#each collectMessagesForIssue(issueId) as message}
												<EmailMessageWithDraft
													message={{
														...message,
														timestampLabel: formatTimestamp(message.timestamp)
													}}
													draft={null}
												/>
											{/each}
											{#each replyDraftsByIssue[issueId] ?? [] as draft}
												<EmailMessageWithDraft
													message={{
														id: draft.message_id,
														subject: draft.subject,
														message: '',
														sender: 'outbound',
														direction: 'outbound',
														timestampLabel: formatTimestamp(draft.updated_at)
													}}
													{draft}
													{vendors}
												/>
											{/each}
										</div>
									</div>
								{/if}

								{#if (newDraftsByIssue[issueId]?.length ?? 0) > 0}
									<div class="space-y-3">
										<div class="flex items-center gap-3 px-1">
											<div
												class="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-100 bg-white"
											>
												<svg
													width="18"
													height="18"
													viewBox="0 0 16 16"
													fill="currentColor"
													class="text-neutral-500"
												>
													<path
														d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v7A1.5 1.5 0 0 1 12.5 12h-9A1.5 1.5 0 0 1 2 10.5zM3.5 3a.5.5 0 0 0-.5.5v.379l5 3.125 5-3.125V3.5a.5.5 0 0 0-.5-.5z"
													/>
												</svg>
											</div>
											<h3 class="text-base font-semibold text-neutral-900">Email drafted</h3>
										</div>
										<div class="space-y-3 pl-11">
											{#each newDraftsByIssue[issueId] ?? [] as draft}
												<EmailMessageWithDraft
													message={{
														id: draft.message_id,
														subject: draft.subject,
														message: '',
														sender: 'outbound',
														direction: 'outbound',
														timestampLabel: formatTimestamp(draft.updated_at)
													}}
													{draft}
													{vendors}
												/>
											{/each}
										</div>
									</div>
								{/if}
							{/if}

							{#each (logsByIssue[issueId] ?? []).filter((l) => l.type !== 'email_inbound' && l.type !== 'email_outbound') as log}
								{#if log.type === 'comment'}
									<div class="flex items-center gap-3 px-1 py-2">
										<div class="relative h-8 w-8 shrink-0">
											<div
												class={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-neutral-700 ${getCommentAuthor(log).color}`}
												aria-label={getCommentAuthor(log).name}
											>
												{getCommentAuthor(log).initial}
											</div>
											<div
												class="absolute -right-1 -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-600 shadow-sm"
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													viewBox="0 0 16 16"
													fill="currentColor"
													class="h-1.5 w-1.5"
												>
													<path
														d="M2 0a2 2 0 0 0-2 2v12.793a.5.5 0 0 0 .854.353l2.853-2.853A1 1 0 0 1 4.414 12H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2z"
													/>
												</svg>
											</div>
										</div>
										<div class="flex-1">
											<div class="rounded-md border-0 bg-white p-0 shadow-none">
												<div class="flex min-w-0 items-start justify-between gap-4">
													<p class="flex-1 text-sm text-neutral-700">{log.body}</p>
													<span class="shrink-0 text-xs text-neutral-400">
														{formatTimestamp(log.created_at)}
													</span>
												</div>
											</div>
										</div>
									</div>
								{:else}
									<div class="flex items-center gap-3 px-1 py-2">
										<div class="relative h-8 w-8 shrink-0">
											<div
												class={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-neutral-700 ${getActivityActor(log).color}`}
												aria-label={getActivityActor(log).name}
											>
												{getActivityActor(log).initial}
											</div>
											<div
												class="absolute -right-1 -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-600 shadow-sm"
											>
												{#if log.type === 'assignee_change'}
													<svg
														xmlns="http://www.w3.org/2000/svg"
														viewBox="0 0 16 16"
														fill="currentColor"
														class="h-2 w-2"
													>
														<path
															d="M3 14s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1zm5-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6"
														/>
													</svg>
												{:else}
													<span
														class={`h-2 w-2 rounded-full border ${getStatusRingClassFromLog(log)}`}
													></span>
												{/if}
											</div>
										</div>
										<div class="flex-1">
											<div class="rounded-md border-0 bg-white p-0 shadow-none">
												<div class="flex min-w-0 items-start justify-between gap-4">
													<p class="flex-1 text-sm text-neutral-700">
														{#if log.type === 'status_change'}
															{getActivityActor(log).name} changed status to {getStatusLabelFromLog(log)}
														{:else if log.type === 'assignee_change'}
															{getActivityActor(log).name} assigned issue to {getAssigneeNameFromLog(log)}
														{/if}
													</p>
													<span class="shrink-0 text-xs text-neutral-400">
														{formatTimestamp(log.created_at)}
													</span>
												</div>
											</div>
										</div>
									</div>
								{/if}
							{/each}

							{#each subIssues as subIssue}
								{#if (messagesByIssue[subIssue.id]?.length ?? 0) || draftIssueIds.includes(subIssue.id) || (logsByIssue[subIssue.id]?.length ?? 0) > 0}
									<div>
										<button
											type="button"
											class="flex w-full cursor-pointer items-center justify-between text-xs font-medium tracking-wide text-neutral-500"
											on:click={() => toggleActivity(subIssue.id)}
										>
											<div
												class="flex items-center gap-2 rounded-md px-3 py-1.5 transition select-none hover:bg-neutral-100"
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="12"
													height="12"
													fill="currentColor"
													class="transition-transform duration-150 ease-in-out"
													class:rotate-[-90deg]={!(activityOpen[subIssue.id] ?? true)}
													viewBox="0 0 16 16"
												>
													<path
														d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
													/>
												</svg>
												<span>{subIssue.name}</span>
											</div>
											<span class="text-neutral-300">
												{messagesByIssue[subIssue.id]?.length ?? 0}
											</span>
										</button>
										<div
											class="grid transition-[grid-template-rows] duration-200 ease-in-out"
											style:grid-template-rows={(activityOpen[subIssue.id] ?? true) ? '1fr' : '0fr'}
										>
											<div class="overflow-hidden">
												<div
													class="space-y-3 py-2 transition-opacity duration-200"
													class:opacity-0={!(activityOpen[subIssue.id] ?? true)}
												>
													{#if (messagesByIssue[subIssue.id]?.length ?? 0) > 0 || (replyDraftsByIssue[subIssue.id]?.length ?? 0) > 0}
														<div class="space-y-3">
															{#if getThreadSubject(subIssue.id)}
																<div class="flex items-center gap-3 px-1">
																	<div
																		class="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-100 bg-white"
																	>
																		<svg
																			width="18"
																			height="18"
																			viewBox="0 0 32 32"
																			fill="none"
																			xmlns="http://www.w3.org/2000/svg"
																		>
																			<path
																				d="M2 11.9556C2 8.47078 2 6.7284 2.67818 5.39739C3.27473 4.22661 4.22661 3.27473 5.39739 2.67818C6.7284 2 8.47078 2 11.9556 2H20.0444C23.5292 2 25.2716 2 26.6026 2.67818C27.7734 3.27473 28.7253 4.22661 29.3218 5.39739C30 6.7284 30 8.47078 30 11.9556V20.0444C30 23.5292 30 25.2716 29.3218 26.6026C28.7253 27.7734 27.7734 28.7253 26.6026 29.3218C25.2716 30 23.5292 30 20.0444 30H11.9556C8.47078 30 6.7284 30 5.39739 29.3218C4.22661 28.7253 3.27473 27.7734 2.67818 26.6026C2 25.2716 2 23.5292 2 20.0444V11.9556Z"
																				fill="white"
																			/>
																			<path
																				d="M22.0515 8.52295L16.0644 13.1954L9.94043 8.52295V8.52421L9.94783 8.53053V15.0732L15.9954 19.8466L22.0515 15.2575V8.52295Z"
																				fill="#EA4335"
																			/>
																			<path
																				d="M23.6231 7.38639L22.0508 8.52292V15.2575L26.9983 11.459V9.17074C26.9983 9.17074 26.3978 5.90258 23.6231 7.38639Z"
																				fill="#FBBC05"
																			/>
																			<path
																				d="M22.0508 15.2575V23.9924H25.8428C25.8428 23.9924 26.9219 23.8813 26.9995 22.6513V11.459L22.0508 15.2575Z"
																				fill="#34A853"
																			/>
																			<path
																				d="M9.94811 24.0001V15.0732L9.94043 15.0669L9.94811 24.0001Z"
																				fill="#C5221F"
																			/>
																			<path
																				d="M9.94014 8.52404L8.37646 7.39382C5.60179 5.91001 5 9.17692 5 9.17692V11.4651L9.94014 15.0667V8.52404Z"
																				fill="#C5221F"
																			/>
																			<path
																				d="M9.94043 8.52441V15.0671L9.94811 15.0734V8.53073L9.94043 8.52441Z"
																				fill="#C5221F"
																			/>
																			<path
																				d="M5 11.4668V22.6591C5.07646 23.8904 6.15673 24.0003 6.15673 24.0003H9.94877L9.94014 15.0671L5 11.4668Z"
																				fill="#4285F4"
																			/>
																		</svg>
																	</div>
																	<h3 class="text-base font-semibold text-neutral-900">
																		{getThreadSubject(subIssue.id)}
																	</h3>
																</div>
															{:else if (replyDraftsByIssue[subIssue.id]?.length ?? 0) > 0}
																<div class="flex items-center gap-3 px-1">
																	<div
																		class="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-100 bg-white"
																	>
																		<svg
																			width="18"
																			height="18"
																			viewBox="0 0 16 16"
																			fill="currentColor"
																			class="text-neutral-500"
																		>
																			<path
																				d="M8 3a5 5 0 1 0 4.546 2.916.5.5 0 0 0-.908-.418A4 4 0 1 1 8 4.5V6a.5.5 0 0 0 .854.354l2-2a.5.5 0 0 0 0-.708l-2-2A.5.5 0 0 0 8 2v1z"
																			/>
																		</svg>
																	</div>
																	<h3 class="text-base font-semibold text-neutral-900">
																		Draft reply
																	</h3>
																</div>
															{/if}
															<div class="space-y-3 pl-11">
																{#each collectMessagesForIssue(subIssue.id) as message}
																	<EmailMessageWithDraft
																		message={{
																			...message,
																			timestampLabel: formatTimestamp(message.timestamp)
																		}}
																		draft={null}
																	/>
																{/each}
																{#each replyDraftsByIssue[subIssue.id] ?? [] as draft}
																	<EmailMessageWithDraft
																		message={{
																			id: draft.message_id,
																			subject: draft.subject,
																			message: '',
																			sender: 'outbound',
																			direction: 'outbound',
																			timestampLabel: formatTimestamp(draft.updated_at)
																		}}
																		{draft}
																		{vendors}
																	/>
																{/each}
															</div>
														</div>
													{/if}

													{#if (newDraftsByIssue[subIssue.id]?.length ?? 0) > 0}
														<div class="space-y-3">
															<div class="flex items-center gap-3 px-1">
																<div
																	class="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-100 bg-white"
																>
																	<svg
																		width="18"
																		height="18"
																		viewBox="0 0 16 16"
																		fill="currentColor"
																		class="text-neutral-500"
																	>
																		<path
																			d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v7A1.5 1.5 0 0 1 12.5 12h-9A1.5 1.5 0 0 1 2 10.5zM3.5 3a.5.5 0 0 0-.5.5v.379l5 3.125 5-3.125V3.5a.5.5 0 0 0-.5-.5z"
																		/>
																	</svg>
																</div>
																<h3 class="text-base font-semibold text-neutral-900">
																	Draft email
																</h3>
															</div>
															<div class="space-y-3 pl-11">
																{#each newDraftsByIssue[subIssue.id] ?? [] as draft}
																	<EmailMessageWithDraft
																		message={{
																			id: draft.message_id,
																			subject: draft.subject,
																			message: '',
																			sender: 'outbound',
																			direction: 'outbound',
																			timestampLabel: formatTimestamp(draft.updated_at)
																		}}
																		{draft}
																		{vendors}
																	/>
																{/each}
															</div>
														</div>
													{/if}

													{#each (logsByIssue[subIssue.id] ?? []).filter((l) => l.type !== 'email_inbound' && l.type !== 'email_outbound') as log}
														{#if log.type === 'comment'}
															<div class="flex items-center gap-3 px-1 py-2">
																<div class="relative h-8 w-8 shrink-0">
																	<div
																		class={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-neutral-700 ${getCommentAuthor(log).color}`}
																		aria-label={getCommentAuthor(log).name}
																	>
																		{getCommentAuthor(log).initial}
																	</div>
																	<div
																		class="absolute -right-1 -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-600 shadow-sm"
																	>
																		<svg
																			xmlns="http://www.w3.org/2000/svg"
																			viewBox="0 0 16 16"
																			fill="currentColor"
																			class="h-1.5 w-1.5"
																		>
																			<path
																				d="M2 0a2 2 0 0 0-2 2v12.793a.5.5 0 0 0 .854.353l2.853-2.853A1 1 0 0 1 4.414 12H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2z"
																			/>
																		</svg>
																	</div>
																</div>
																<div class="flex-1">
																	<div class="rounded-md border-0 bg-white p-0 shadow-none">
																		<div class="flex min-w-0 items-start justify-between gap-4">
																			<p class="flex-1 text-sm text-neutral-700">{log.body}</p>
																			<span class="shrink-0 text-xs text-neutral-400">
																				{formatTimestamp(log.created_at)}
																			</span>
																		</div>
																	</div>
																</div>
															</div>
														{:else}
															<div class="flex items-center gap-3 px-1 py-2">
																<div class="relative h-8 w-8 shrink-0">
																	<div
																		class={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-neutral-700 ${getActivityActor(log).color}`}
																		aria-label={getActivityActor(log).name}
																	>
																		{getActivityActor(log).initial}
																	</div>
																	<div
																		class="absolute -right-1 -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-600 shadow-sm"
																	>
																		{#if log.type === 'assignee_change'}
																			<svg
																				xmlns="http://www.w3.org/2000/svg"
																				viewBox="0 0 16 16"
																				fill="currentColor"
																				class="h-2 w-2"
																			>
																				<path
																					d="M3 14s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1zm5-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6"
																				/>
																			</svg>
																		{:else}
																			<span
																				class={`h-2 w-2 rounded-full border ${getStatusRingClassFromLog(log)}`}
																			></span>
																		{/if}
																	</div>
																</div>
																<div class="flex-1">
																	<div class="rounded-md border-0 bg-white p-0 shadow-none">
																		<div class="flex min-w-0 items-start justify-between gap-4">
																			<p class="flex-1 text-sm text-neutral-700">
																				{#if log.type === 'status_change'}
																					{getActivityActor(log).name} changed status to {getStatusLabelFromLog(log)}
																				{:else if log.type === 'assignee_change'}
																					{getActivityActor(log).name} assigned issue to {getAssigneeNameFromLog(log)}
																				{/if}
																			</p>
																			<span class="shrink-0 text-xs text-neutral-400">
																				{formatTimestamp(log.created_at)}
																			</span>
																		</div>
																	</div>
																</div>
															</div>
														{/if}
													{/each}
												</div>
											</div>
										</div>
									</div>
								{/if}
							{/each}
						</div>
					{/if}
					<div class="mt-6">
						<div
							class="rounded-md border border-neutral-100 bg-white px-4 py-3 shadow-[0_2px_6px_rgba(0,0,0,0.08)]"
						>
							<textarea
								class="w-full resize-none border-0 bg-transparent p-0 text-sm text-neutral-700 outline-none placeholder:text-neutral-400 focus:shadow-none focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
								placeholder="Leave a comment..."
								rows="1"
								bind:value={commentBody}
								bind:this={commentTextarea}
								on:input={resizeCommentTextarea}
							></textarea>
							<div class="mt-1 flex items-center justify-end">
								<button
									type="button"
									class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 focus-visible:outline-none disabled:opacity-50"
									aria-label="Send comment"
									disabled={!commentBody.trim() || !issueId}
									on:click={handleCommentSend}
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="18"
										height="18"
										viewBox="0 0 16 16"
										fill="currentColor"
									>
										<path
											d="M8 12a.5.5 0 0 0 .5-.5V4.707l2.147 2.147a.5.5 0 0 0 .707-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 4.707V11.5A.5.5 0 0 0 8 12z"
										/>
									</svg>
								</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>

		<aside class="flex w-1/5 border-l border-neutral-200">
			<div
				class="flex w-full flex-col px-4 transition-opacity duration-150"
				class:opacity-0={!$pageReady}
			>
				<div class="flex items-center justify-between gap-2 py-2">
					<span class="text-sm text-neutral-600">{issueReadableId ?? issueKey}</span>
					<button
						type="button"
						class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100"
						on:click={copyIssueLink}
						aria-label="Copy issue link"
						title="Copy issue link"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="16"
							height="16"
							fill="currentColor"
							viewBox="0 0 16 16"
						>
							<path
								d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1 1 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4 4 0 0 1-.128-1.287z"
							/>
							<path
								d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243z"
							/>
						</svg>
					</button>
				</div>
				<div class="space-y-2 py-4 text-sm text-neutral-600">
					<div class="relative">
						<button
							type="button"
							class={`-ml-2 flex w-40 items-center gap-2 rounded-sm p-1 px-2 transition ${
								canEditIssue ? 'hover:bg-stone-100' : 'cursor-default opacity-60'
							}`}
							disabled={!canEditIssue}
							aria-disabled={!canEditIssue}
							on:click|stopPropagation={() => {
								if (!canEditIssue) return;
								statusOpen = !statusOpen;
							}}
						>
							<span class={`h-3.5 w-3.5 rounded-full border ${statusMeta.statusClass}`}></span>
							<span>{statusMeta.label}</span>
						</button>
						{#if statusOpen && canEditIssue}
							<div
								class="absolute right-0 left-auto z-10 mt-2 w-48 origin-top-right rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
								on:click|stopPropagation
							>
								{#each statusCycle as status}
									<button
										type="button"
										class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
											statusKey === status ? 'bg-neutral-50' : ''
										}`}
										on:click={() => {
											statusOpen = false;
											handleStatusChange(status);
										}}
									>
										<span
											class={`h-3.5 w-3.5 rounded-full border ${
												(statusConfig[status] ?? statusConfig.todo).statusClass
											}`}
										></span>
										<span>{(statusConfig[status] ?? statusConfig.todo).label}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<div class="relative">
						<button
							type="button"
							class={`-ml-2 flex w-40 items-center gap-2 rounded-sm p-1 px-2 transition ${
								canEditIssue ? 'hover:bg-stone-100' : 'cursor-default opacity-60'
							}`}
							disabled={!canEditIssue}
							aria-disabled={!canEditIssue}
							on:click|stopPropagation={() => {
								if (!canEditIssue) return;
								assigneeOpen = !assigneeOpen;
							}}
						>
							{#if assignee}
								<div
									class={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${getAssigneeAvatar(assignee).color}`}
									aria-label={getAssigneeAvatar(assignee).name}
								>
									{getAssigneeAvatar(assignee).initial}
								</div>
							{:else}
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									fill="currentColor"
									class="text-neutral-400"
									viewBox="0 0 16 16"
								>
									<path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0" />
									<path
										fill-rule="evenodd"
										d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1"
									/>
								</svg>
							{/if}
							<span class="truncate">{assigneeName}</span>
						</button>
						{#if assigneeOpen && canEditIssue}
							<div
								class="absolute right-0 left-auto z-10 mt-2 w-56 origin-top-right rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
								on:click|stopPropagation
							>
								<button
									type="button"
									class="flex w-full items-center gap-2 px-3 py-2 text-left text-neutral-600 transition hover:bg-neutral-50"
									on:click={() => handleAssigneeSelect(null)}
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="16"
										height="16"
										fill="currentColor"
										class="text-neutral-400"
										viewBox="0 0 16 16"
									>
										<path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0" />
										<path
											fill-rule="evenodd"
											d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1"
										/>
									</svg>
									<span class="font-medium text-neutral-500"> Unassigned </span>
								</button>
								<div class="my-1 h-px bg-neutral-100"></div>
								{#if membersLoading}
									<div class="px-3 py-2 text-neutral-400">Loading members...</div>
								{:else if assignableMembers.length}
									{#each assignableMembers as member}
										<button
											type="button"
											class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
												assignee?.id === member.user_id ? 'bg-neutral-50' : ''
											}`}
											on:click={() => handleAssigneeSelect(member)}
										>
											<div
												class={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${getMemberAvatar(member).color}`}
												aria-label={getMemberAvatar(member).name}
											>
												{getMemberAvatar(member).initial}
											</div>
											<span class="truncate">
												{member.users?.name ??
													member.name ??
													member.users?.id ??
													member.user_id ??
													'Unknown member'}
											</span>
											<span
												class="ml-auto rounded-full bg-stone-100 px-2 py-0.5 font-medium text-neutral-600"
											>
												{roleLabels[member.role] ?? member.role}
											</span>
										</button>
									{/each}
								{:else if membersReady}
									<div class="px-3 py-2 text-neutral-400">No members found.</div>
								{:else}
									<div class="px-3 py-2 text-neutral-400">Unable to load members.</div>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</div>
		</aside>
	</div>
{:else}
	<div class="h-full w-full bg-white"></div>
{/if}
