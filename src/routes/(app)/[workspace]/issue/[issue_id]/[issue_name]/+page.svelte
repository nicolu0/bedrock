<script>
	// @ts-nocheck
	import { browser } from '$app/environment';
	import { goto, preloadData } from '$app/navigation';
	import { page } from '$app/stores';
	import { onDestroy, onMount } from 'svelte';

	import EmailMessageWithDraft from '$lib/components/EmailMessageWithDraft.svelte';
	import AppfolioDraftMessage from '$lib/components/AppfolioDraftMessage.svelte';
	import SidebarButton from '$lib/components/SidebarButton.svelte';
	import { toggleChatPanel } from '$lib/stores/rightPanel.js';
	import { pageReady } from '$lib/stores/pageReady';
	import { rightPanel } from '$lib/stores/rightPanel.js';
	import { supabase } from '$lib/supabaseClient.js';
	import {
		getIssueDetailById,
		getIssueDetailByReadableId,
		seedIssueDetail
	} from '$lib/stores/issueDetailCache.js';

	export let data;

	$: role = (data?.role ?? '').toString().toLowerCase();
	$: canEditIssue = role === 'admin' || role === 'bedrock';

	const APPFOLIO_KEY = 'appfolio_enabled';
	let appfolioEnabled = false;
	$: if (browser) {
		appfolioEnabled = window.localStorage.getItem(APPFOLIO_KEY) === 'true';
	}

	const syncAppfolioSettings = () => {
		if (!browser) return;
		const enabled = window.localStorage.getItem(APPFOLIO_KEY) === 'true';
		appfolioEnabled = enabled;
	};

	if (!browser) {
		pageReady.set(false);
	}

	let isMobileViewport = false;
	let handleViewport;

	onMount(() => {
		syncAppfolioSettings();
		const mobileQuery = window.matchMedia('(max-width: 639px)');
		isMobileViewport = mobileQuery.matches;
		subIssuesOpen = !isMobileViewport;
		const handleStorage = (event) => {
			if (event.key === APPFOLIO_KEY) {
				syncAppfolioSettings();
			}
		};
		handleViewport = () => refreshOpenFieldMenus();
		window.addEventListener('storage', handleStorage);
		window.addEventListener('resize', handleViewport);
		window.addEventListener('scroll', handleViewport, true);
		return () => window.removeEventListener('storage', handleStorage);
	});

	const statusConfig = {
		in_progress: {
			label: 'In Progress',
			statusClass: 'border-orange-500 text-orange-600'
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
		bedrock: 'Bedrock',
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

	const getTimestamp = (value) => {
		if (!value) return 0;
		const ts = new Date(value).getTime();
		return Number.isFinite(ts) ? ts : 0;
	};

	const getLatestTimestamp = (items, field) =>
		(items ?? []).reduce((latest, item) => {
			const next = getTimestamp(item?.[field]);
			return next > latest ? next : latest;
		}, 0);

	// ── Local state from server data ────────────────────────────────────────────

	const _initCached = browser ? getIssueDetailByReadableId($page.params.issue_id) : null;
	let issue = _initCached?.issue ?? (data.issue instanceof Promise ? null : data.issue) ?? null;
	// True while waiting for the server's issue data — shown even on cache hits so
	// title/description/breadcrumb only reveal when fully resolved (no stagger).
	let _issueLoading = browser && !_initCached && data.issue instanceof Promise;
	let assignee = null;
	let issueAssigneeId = issue?.assignee_id ?? null;
	// Tracks which Promise we've already subscribed to — prevents the reactive block from
	// re-attaching .then() every time `issue` changes (Svelte always dirtifies objects).
	let _subscribedIssuePromise = null;
	let commentBody = '';
	let commentTextarea;
	let subIssueHoverId = null;
	let subIssueTooltipX = 0;
	let subIssueTooltipY = 0;
	let subIssueTooltipVisible = false;
	let issueOpenedAt = 0;
	let lastMarkedIssueId = null;
	let lastMarkedAt = 0;

	// ── Streaming resolution for secondary data ───────────────────────────────

	let _resolvedSubIssues = _initCached?.subIssues ?? [];
	let _subIssuesLoading = false;
	$: {
		if (data.subIssues instanceof Promise) {
			_subIssuesLoading = true;
			data.subIssues.then((d) => {
				_resolvedSubIssues = d ?? [];
				_subIssuesLoading = false;
				if (browser && issue) {
					seedIssueDetail(issue, d ?? []);
					// Seed each subissue individually so navigating into one gets a cache hit.
					for (const sub of d ?? []) seedIssueDetail(sub, []);
				}
			});
		} else {
			_resolvedSubIssues = data.subIssues ?? [];
			_subIssuesLoading = false;
		}
	}

	let _resolvedActivity = null;

	// Defined as a plain function (not inside a $: block) so Svelte's static
	// dependency analysis doesn't treat `messagesByIssue` as a reactive dep of
	// the block below — which would cause a _resolvedActivity → messagesByIssue
	// → _resolvedActivity cycle.
	function mergeAndSetActivity(d) {
		const serverIds = new Set(
			Object.values(d.messagesByIssue ?? {})
				.flat()
				.map((m) => m.id)
		);
		const mergedMessages = { ...d.messagesByIssue };
		for (const [id, msgs] of Object.entries(messagesByIssue)) {
			const localOnly = msgs.filter((m) => !serverIds.has(m.id));
			if (localOnly.length) {
				mergedMessages[id] = [...(mergedMessages[id] ?? []), ...localOnly];
			}
		}
		_resolvedActivity = { ...d, messagesByIssue: mergedMessages };
	}

	$: {
		if (data.activityData instanceof Promise) {
			data.activityData.then((d) => {
				if (d) mergeAndSetActivity(d);
			});
		} else if (data.activityData) {
			_resolvedActivity = data.activityData;
		}
	}

	let _resolvedLogs = null;
	$: {
		if (data.activityLogsData instanceof Promise) {
			_resolvedLogs = null;
			data.activityLogsData.then((d) => {
				if (d) _resolvedLogs = d;
			});
		} else if (data.activityLogsData) {
			_resolvedLogs = data.activityLogsData;
		}
	}

	let _resolvedMembers = [];
	$: {
		if (data.members instanceof Promise) {
			data.members.then((m) => {
				_resolvedMembers = m ?? [];
			});
		} else {
			_resolvedMembers = data.members ?? [];
		}
	}

	let _resolvedVendors = [];
	$: {
		if (data.vendors instanceof Promise) {
			data.vendors.then((v) => {
				_resolvedVendors = v ?? [];
			});
		} else {
			_resolvedVendors = data.vendors ?? [];
		}
	}

	let _resolvedProperties = [];
	$: {
		const propsData = $page.data?.properties;
		if (propsData instanceof Promise) {
			propsData.then((list) => {
				_resolvedProperties = Array.isArray(list) ? list : [];
			});
		} else {
			_resolvedProperties = Array.isArray(propsData) ? propsData : [];
		}
	}

	let _resolvedUnits = [];
	$: {
		const unitsData = $page.data?.units;
		if (unitsData instanceof Promise) {
			unitsData.then((list) => {
				_resolvedUnits = Array.isArray(list) ? list : [];
			});
		} else {
			_resolvedUnits = Array.isArray(unitsData) ? unitsData : [];
		}
	}

	$: subIssues = _resolvedSubIssues;
	$: messagesByIssue = _resolvedActivity?.messagesByIssue ?? {};
	$: emailDraftsByMessageId = _resolvedActivity?.emailDraftsByMessageId ?? {};
	$: draftIssueIds = _resolvedActivity?.draftIssueIds ?? [];
	$: logsByIssue = _resolvedLogs?.logsByIssue ?? {};
	$: members = _resolvedMembers;
	$: vendors = _resolvedVendors;
	$: properties = _resolvedProperties;
	$: units = _resolvedUnits;

	// Handle streaming data.issue (always a Promise from server)
	$: if (data.issue instanceof Promise && data.issue !== _subscribedIssuePromise) {
		_subscribedIssuePromise = data.issue;
		// On navigation to a different issue: switch to cache or clear
		if (issue?.readableId && issue.readableId !== $page.params.issue_id) {
			_issueLoading = true;
			const cached = browser ? getIssueDetailByReadableId($page.params.issue_id) : null;
			issue = cached?.issue ?? null;
			_resolvedSubIssues = cached?.subIssues ?? [];
			_resolvedActivity = null;
			_resolvedLogs = null;
			issueAssigneeId = issue?.assignee_id ?? null;
			assignee = null;
		}
		data.issue.then((d) => {
			if (!d || (d.readableId && d.readableId !== $page.params.issue_id)) return;
			issue = d;
			_issueLoading = false;
			issueAssigneeId = d.assignee_id ?? null;
			assignee = null;
			if (browser) seedIssueDetail(d);
			pageReady.set(true);
		});
	}

	// Re-sync after invalidation (when load returns resolved value)
	$: if (data.issue && !(data.issue instanceof Promise) && data.issue.id === issue?.id) {
		issue = { ...issue, ...data.issue };
		issueAssigneeId = data.issue.assignee_id ?? issueAssigneeId;
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
	$: issueUpdatedAt = issue?.updated_at ?? issue?.updatedAt ?? null;
	$: issueReadableId = issue?.readableId ?? issueKey;
	let issuePropertyId = issue?.property_id ?? issue?.propertyId ?? null;
	let issueUnitId = issue?.unit_id ?? issue?.unitId ?? null;
	$: if (issue) {
		issuePropertyId = issue.property_id ?? issue.propertyId ?? null;
		issueUnitId = issue.unit_id ?? issue.unitId ?? null;
	}
	$: propertiesById = properties.reduce((acc, property) => {
		if (!property?.id) return acc;
		acc[property.id] = property;
		return acc;
	}, {});
	$: unitsById = units.reduce((acc, unit) => {
		if (!unit?.id) return acc;
		acc[unit.id] = unit;
		return acc;
	}, {});
	$: availableUnits = issuePropertyId
		? units.filter((unit) => unit.property_id === issuePropertyId)
		: units;
	$: propertyName = issuePropertyId
		? (propertiesById[issuePropertyId]?.name ?? issue?.property ?? 'Unknown property')
		: 'No property';
	$: unitName = issueUnitId
		? (unitsById[issueUnitId]?.name ?? issue?.unit ?? 'Unknown unit')
		: 'No unit';

	$: if (issue) pageReady.set(true);

	$: isAppfolioIssue = issue?.source === 'appfolio';

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
			return (r === 'admin' || r === 'bedrock' || r === 'member') && Boolean(member?.user_id);
		})
		.sort((a, b) => {
			const order = { admin: 0, bedrock: 1, member: 2 };
			const rA = (a?.role ?? '').toLowerCase();
			const rB = (b?.role ?? '').toLowerCase();
			const roleDiff = (order[rA] ?? 9) - (order[rB] ?? 9);
			if (roleDiff !== 0) return roleDiff;
			const nameA = (a?.users?.name ?? '').toString();
			const nameB = (b?.users?.name ?? '').toString();
			return nameA.localeCompare(nameB);
		});

	let subIssueAssigneeOverrides = new Map();
	const setSubIssueAssigneeOverride = (id, assigneeId) => {
		if (!id) return;
		const next = new Map(subIssueAssigneeOverrides);
		if (assigneeId) {
			next.set(id, assigneeId);
		} else {
			next.delete(id);
		}
		subIssueAssigneeOverrides = next;
	};

	const buildSubIssuesWithAssignees = (items) =>
		(items ?? []).map((subIssue) => {
			const overrideAssigneeId = subIssueAssigneeOverrides.get(subIssue?.id) ?? null;
			const assigneeId =
				overrideAssigneeId ?? subIssue?.assigneeId ?? subIssue?.assignee_id ?? null;
			const resolved =
				resolveAssigneeFromId(assigneeId, membersByUserId) ?? placeholderAssignee(assigneeId);
			return { ...subIssue, assignee: resolved };
		});

	$: subIssuesWithAssignees = buildSubIssuesWithAssignees(subIssues);

	$: assigneeName = assignee?.name ?? assignee?.users?.name ?? 'Unassigned';
	$: subIssueProgress = `${subIssues.filter((item) => item.status === 'done').length}/${subIssues.length}`;

	$: latestIssueActivityAt = (() => {
		if (!issueId) return 0;
		const logTime = getLatestTimestamp(logsByIssue[issueId], 'created_at');
		const draftTime = getLatestTimestamp(draftsByIssue[issueId], 'updated_at');
		const messageTime = getLatestTimestamp(messagesByIssue[issueId], 'timestamp');
		const issueTime = getTimestamp(issueUpdatedAt);
		return Math.max(logTime, draftTime, messageTime, issueTime);
	})();

	$: if (issueId && issueId !== lastMarkedIssueId) {
		lastMarkedIssueId = issueId;
		issueOpenedAt = Date.now();
		lastMarkedAt = 0;
	}

	const markIssueSeen = async () => {
		if (!browser || !issueId) return;
		await fetch('/api/issue-reads/mark-seen', {
			method: 'POST',
			keepalive: true,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ issue_id: issueId })
		}).catch(() => {});
	};

	$: if (browser && issueId) {
		const nextTimestamp = latestIssueActivityAt || issueOpenedAt;
		if (nextTimestamp && nextTimestamp > lastMarkedAt) {
			lastMarkedAt = nextTimestamp;
			markIssueSeen();
		}
	}

	// ── Navigation (prev/next removed — no issuesCache) ─────────────────────────

	$: prevIssue = null;
	$: nextIssue = null;
	$: currentIndex = -1;
	$: totalIssues = 0;

	// ── Activity derived ─────────────────────────────────────────────────────────

	let suppressedDraftKeys = new Set();

	const suppressDraftKey = (key) => {
		if (!key) return;
		suppressedDraftKeys = new Set([...suppressedDraftKeys, key]);
	};

	const unsuppressDraftKey = (key) => {
		if (!key || !suppressedDraftKeys.has(key)) return;
		const next = new Set(suppressedDraftKeys);
		next.delete(key);
		suppressedDraftKeys = next;
	};

	$: draftsByIssue = Object.values(emailDraftsByMessageId ?? {}).reduce((acc, draft) => {
		if (!draft?.issue_id) return acc;
		const key = draft.message_id ?? draft.id;
		if (key && suppressedDraftKeys.has(key)) return acc;
		if (!acc[draft.issue_id]) acc[draft.issue_id] = [];
		acc[draft.issue_id].push(draft);
		return acc;
	}, {});

	$: hasTasks =
		subIssues.some((item) => (draftsByIssue[item.id]?.length ?? 0) > 0) ||
		(draftsByIssue[issueId]?.length ?? 0) > 0;

	$: recommendedVendorsByIssueId = Object.fromEntries([
		[issueId, issue?.recommended_vendors ?? []],
		...subIssues.map((s) => [s.id, s.recommended_vendors ?? []])
	]);

	$: hasActivity =
		subIssues.some((item) => (logsByIssue[item.id] ?? []).length > 0) ||
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

	$: approvedAppfolioDraftsByIssue = Object.entries(logsByIssue ?? {}).reduce((acc, [id, logs]) => {
		const approved = (logs ?? [])
			.filter((log) => log?.type === 'appfolio_approved' && log?.data?.draft)
			.map((log) => {
				const draft = log?.data?.draft ?? {};
				return {
					log,
					draft: {
						id: draft?.id ?? log?.data?.draft_id ?? null,
						issue_id: log?.issue_id ?? id,
						message_id: draft?.message_id ?? null,
						subject: draft?.subject ?? null,
						body: draft?.body ?? '',
						recipient_email: draft?.recipient_email ?? null,
						recipient_emails: draft?.recipient_emails ?? null,
						channel: draft?.channel ?? 'appfolio'
					}
				};
			});
		if (approved.length) acc[id] = approved;
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

	const handleDraftSent = (detail) => {
		if (!detail) return;
		const { status, message, tempId, issueId, draft, draftKey } = detail;
		const targetIssueId = issueId ?? message?.issue_id ?? draft?.issue_id ?? null;
		if (status === 'optimistic') {
			suppressDraftKey(draftKey ?? draft?.message_id ?? draft?.id);
			return;
		}
		if (status === 'confirmed') {
			unsuppressDraftKey(draftKey ?? draft?.message_id ?? draft?.id);
			if (tempId && targetIssueId) {
				removeMessageFromCache({ id: tempId, issue_id: targetIssueId });
			}
			if (message) {
				applyMessageDelta({ ...message, _ui: { expanded: true } });
			}
			if (draft) removeDraftFromCache(draft);
			return;
		}
		if (status === 'error') {
			unsuppressDraftKey(draftKey ?? draft?.message_id ?? draft?.id);
			if (tempId && targetIssueId) {
				removeMessageFromCache({ id: tempId, issue_id: targetIssueId });
			}
			if (draft) applyDraftDelta(draft);
		}
	};

	const handleAppfolioAssigneeUpdate = (detail) => {
		const nextAssigneeId = detail?.assigneeId ?? null;
		if (!nextAssigneeId || !issue?.id) return;
		const targetIds = new Set([detail?.issueId, detail?.parentIssueId].filter(Boolean));
		const isRootTarget = targetIds.has(issue.id);
		const isSubIssueTarget = Boolean(
			detail?.issueId && subIssues.some((sub) => sub.id === detail.issueId)
		);
		if (!isRootTarget && !isSubIssueTarget) return;
		const nextAssignee =
			resolveAssigneeFromId(nextAssigneeId, membersByUserId) ?? placeholderAssignee(nextAssigneeId);
		if (isRootTarget) {
			issue = {
				...issue,
				assignee_id: nextAssigneeId,
				assigneeId: nextAssigneeId,
				updated_at: new Date().toISOString()
			};
			issueAssigneeId = nextAssigneeId;
			assignee = nextAssignee;
		}
		if (isSubIssueTarget) {
			setSubIssueAssigneeOverride(detail.issueId, nextAssigneeId);
			const nextPayload = {
				id: detail.issueId,
				assignee_id: nextAssigneeId,
				parent_id: detail?.parentIssueId ?? issue.id,
				updated_at: new Date().toISOString()
			};
			const updatedSubIssues = subIssues.map((sub) =>
				sub.id === detail.issueId ? mergeSubIssue(sub, nextPayload) : sub
			);
			subIssues = sortSubIssues(updatedSubIssues);
			if (Array.isArray(_resolvedSubIssues)) {
				const updatedResolved = _resolvedSubIssues.map((sub) =>
					sub.id === detail.issueId ? mergeSubIssue(sub, nextPayload) : sub
				);
				_resolvedSubIssues = sortSubIssues(updatedResolved);
			}
			subIssuesWithAssignees = buildSubIssuesWithAssignees(subIssues);
		}
		if (browser) seedIssueDetail(issue, subIssues);
	};

	// ── Activity log helpers ─────────────────────────────────────────────────────

	const getStatusRingClassFromLog = (log) => {
		const nextStatus = log?.data?.to ?? null;
		if (!nextStatus) return 'border-neutral-400';
		const statusClass = statusConfig[nextStatus]?.statusClass ?? '';
		const match = statusClass.match(/border-[^\s]+/g) ?? [];
		return match[0] ?? 'border-neutral-400';
	};

	const ACTIVITY_LOG_WINDOW_MS = 60 * 60 * 1000;

	const getAppfolioApprovedBy = (id) => {
		const list = logsByIssue?.[id] ?? [];
		const last = [...list].reverse().find((entry) => entry?.type === 'appfolio_approved');
		return last?.data?.approved_by ?? null;
	};

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

		if (!error) {
			const nowIso = new Date().toISOString();
			issue = { ...issue, updated_at: nowIso };
			fetch('/api/issues/touch', {
				method: 'POST',
				keepalive: true,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ issue_id: issueId })
			}).catch(() => {});
		}

		if (error || !created?.id) {
			removeActivityLogFromCache(optimisticLog);
			return;
		}

		removeActivityLogFromCache(optimisticLog);
		applyActivityLogDelta(created);
	};

	const resizeCommentTextarea = () => {
		if (!commentTextarea) return;
		commentTextarea.style.height = 'auto';
		commentTextarea.style.height = `${commentTextarea.scrollHeight}px`;
	};

	// ── Status and assignee changes ──────────────────────────────────────────────

	const statusCycle = ['todo', 'in_progress', 'done'];

	const syncIssueStatusCaches = (nextStatus) => {
		if (!browser || !issue?.id) return;
		const currentDetail = getIssueDetailById(issue.id);
		seedIssueDetail(
			{ ...(currentDetail?.issue ?? issue), status: nextStatus },
			currentDetail?.subIssues ?? []
		);
		if (!issue?.parent_id) return;
		const parentDetail = getIssueDetailById(issue.parent_id);
		if (!parentDetail?.issue) return;
		const nextSubIssues = (parentDetail.subIssues ?? []).map((sub) =>
			sub.id === issue.id ? { ...sub, status: nextStatus } : sub
		);
		seedIssueDetail(parentDetail.issue, nextSubIssues);
	};

	const handleStatusChange = async (newStatus) => {
		if (!canEditIssue) return;
		const prevStatus = statusKey;
		issue = { ...issue, status: newStatus };

		const { error } = await supabase
			.from('issues')
			.update({ status: newStatus, updated_at: new Date().toISOString() })
			.eq('id', issueId);

		if (error) {
			issue = { ...issue, status: prevStatus };
			return;
		}

		syncIssueStatusCaches(newStatus);

		if (isAppfolioIssue) {
			fetch('/api/appfolio-actions/log', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ issueId, action: 'status_change', meta: { status: newStatus } })
			}).catch(() => {});
		}

		upsertIssueActivityLog({
			id: issueId,
			type: 'status_change',
			fromValue: prevStatus,
			toValue: newStatus
		});
	};

	const handleUrgentChange = async (nextUrgent) => {
		if (!canEditIssue) return;
		if (!issueId) return;
		if (issue?.parent_id) return;
		const prevUrgent = issue?.urgent ?? false;
		if (prevUrgent === nextUrgent) {
			urgentOpen = false;
			return;
		}
		issue = { ...issue, urgent: nextUrgent };
		urgentOpen = false;
		const { error } = await supabase
			.from('issues')
			.update({ urgent: nextUrgent, updated_at: new Date().toISOString() })
			.eq('id', issueId);
		if (error) {
			issue = { ...issue, urgent: prevUrgent };
			return;
		}
		if (!issue?.parent_id) {
			openUrgencyPolicyPrompt(nextUrgent);
		}
	};

	let statusOpen = false;
	let assigneeOpen = false;
	let propertyOpen = false;
	let unitOpen = false;
	let urgentOpen = false;
	let urgentHelpOpen = false;
	$: rightSidebarMenuOpen =
		statusOpen || assigneeOpen || propertyOpen || unitOpen || urgentOpen || urgentHelpOpen;
	$: fieldsDesktopAlignClass =
		$rightPanel?.open && $rightPanel?.type === 'chat'
			? 'right-0 left-auto origin-top-right'
			: 'left-0 right-auto origin-top-left';

	let propertyAnchorDesktop;
	let unitAnchorDesktop;
	let statusAnchorDesktop;
	let assigneeAnchorDesktop;
	let urgentAnchorDesktop;
	let propertyAnchorMobile;
	let unitAnchorMobile;
	let statusAnchorMobile;
	let assigneeAnchorMobile;
	let urgentAnchorMobile;

	let propertyMenuStyle = '';
	let unitMenuStyle = '';
	let statusMenuStyle = '';
	let assigneeMenuStyle = '';
	let urgentMenuStyle = '';

	const FIELD_MENU_PADDING = 8;
	const FIELD_MENU_GAP = 8;
	const FIELD_MENU_WIDTH_WIDE = 224;
	const FIELD_MENU_WIDTH_NARROW = 192;

	const getFieldAnchor = (desktopAnchor, mobileAnchor) =>
		isMobileViewport ? mobileAnchor : desktopAnchor;

	const buildFieldMenuStyle = (anchor, menuWidth) => {
		if (!browser || !anchor) return '';
		const rect = anchor.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		let left = rect.left;
		if (left + menuWidth > viewportWidth - FIELD_MENU_PADDING) {
			left = Math.max(FIELD_MENU_PADDING, rect.right - menuWidth);
		}
		left = Math.max(FIELD_MENU_PADDING, left);
		const top = rect.bottom + FIELD_MENU_GAP;
		return `left: ${left}px; top: ${top}px;`;
	};

	const refreshOpenFieldMenus = () => {
		if (propertyOpen) {
			propertyMenuStyle = buildFieldMenuStyle(
				getFieldAnchor(propertyAnchorDesktop, propertyAnchorMobile),
				FIELD_MENU_WIDTH_WIDE
			);
		}
		if (unitOpen) {
			unitMenuStyle = buildFieldMenuStyle(
				getFieldAnchor(unitAnchorDesktop, unitAnchorMobile),
				FIELD_MENU_WIDTH_WIDE
			);
		}
		if (statusOpen) {
			statusMenuStyle = buildFieldMenuStyle(
				getFieldAnchor(statusAnchorDesktop, statusAnchorMobile),
				FIELD_MENU_WIDTH_NARROW
			);
		}
		if (assigneeOpen) {
			assigneeMenuStyle = buildFieldMenuStyle(
				getFieldAnchor(assigneeAnchorDesktop, assigneeAnchorMobile),
				FIELD_MENU_WIDTH_WIDE
			);
		}
		if (urgentOpen) {
			urgentMenuStyle = buildFieldMenuStyle(
				getFieldAnchor(urgentAnchorDesktop, urgentAnchorMobile),
				FIELD_MENU_WIDTH_NARROW
			);
		}
	};
	let showUrgencyPolicyPrompt = false;
	let urgencyPolicyValue = 'not_urgent';
	let urgencyPolicyIssue = '';
	let urgencyPolicyMatchingId = null;
	let urgencyPolicyLoading = false;
	let urgencyPolicyError = '';

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
			.update({ assignee_id: nextId, updated_at: new Date().toISOString() })
			.eq('id', issueId);

		if (error) {
			assignee = prevAssignee;
			issueAssigneeId = prevAssigneeId;
			return;
		}

		if (isAppfolioIssue) {
			fetch('/api/appfolio-actions/log', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					issueId,
					action: 'vendor_assign',
					meta: { vendorName: nextAssignee?.name ?? null }
				})
			}).catch(() => {});
		}

		upsertIssueActivityLog({
			id: issueId,
			type: 'assignee_change',
			fromValue: prevAssigneeId,
			toValue: nextId
		});
	};

	const handlePropertySelect = async (propertyId) => {
		if (!canEditIssue) return;
		if (!issueId) return;
		const nextPropertyId = propertyId ?? null;
		const prevIssue = { ...issue };
		const nextPropertyName = nextPropertyId
			? (propertiesById[nextPropertyId]?.name ?? 'Unknown property')
			: null;
		issue = {
			...issue,
			property_id: nextPropertyId,
			propertyId: nextPropertyId,
			property: nextPropertyName,
			unit_id: null,
			unitId: null,
			unit: null
		};
		issuePropertyId = nextPropertyId;
		issueUnitId = null;
		propertyOpen = false;
		unitOpen = false;
		const { error } = await supabase
			.from('issues')
			.update({
				property_id: nextPropertyId,
				unit_id: null,
				updated_at: new Date().toISOString()
			})
			.eq('id', issueId);
		if (error) {
			issue = prevIssue;
			issuePropertyId = prevIssue.property_id ?? prevIssue.propertyId ?? null;
			issueUnitId = prevIssue.unit_id ?? prevIssue.unitId ?? null;
		}
	};

	const handleUnitSelect = async (unitId) => {
		if (!canEditIssue) return;
		if (!issueId) return;
		const nextUnitId = unitId ?? null;
		const prevIssue = { ...issue };
		let nextPropertyId = issuePropertyId ?? null;
		let nextPropertyName = issue?.property ?? null;
		let nextUnitName = null;
		if (nextUnitId) {
			const unit = unitsById[nextUnitId];
			if (!unit) return;
			nextUnitName = unit.name ?? null;
			if (unit.property_id) {
				nextPropertyId = unit.property_id;
				nextPropertyName = propertiesById[nextPropertyId]?.name ?? nextPropertyName;
			}
		}
		issue = {
			...issue,
			unit_id: nextUnitId,
			unitId: nextUnitId,
			unit: nextUnitName,
			property_id: nextPropertyId,
			propertyId: nextPropertyId,
			property: nextPropertyName
		};
		issuePropertyId = nextPropertyId;
		issueUnitId = nextUnitId;
		unitOpen = false;
		propertyOpen = false;
		const { error } = await supabase
			.from('issues')
			.update({
				unit_id: nextUnitId,
				property_id: nextPropertyId,
				updated_at: new Date().toISOString()
			})
			.eq('id', issueId);
		if (error) {
			issue = prevIssue;
			issuePropertyId = prevIssue.property_id ?? prevIssue.propertyId ?? null;
			issueUnitId = prevIssue.unit_id ?? prevIssue.unitId ?? null;
		}
	};

	// ── Utility functions ────────────────────────────────────────────────────────

	$: isSubissue = Boolean(issue?.parent_id);
	$: displayUrgent = isSubissue ? (issue?.root_urgent ?? issue?.urgent) : issue?.urgent;

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

	const normalizePolicyLabel = (value) =>
		(value ?? '')
			.toString()
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.replace(/\s+/g, ' ');

	const openUrgencyPolicyPrompt = async (nextUrgent) => {
		if (!issue) return;
		urgencyPolicyValue = nextUrgent ? 'urgent' : 'not_urgent';
		urgencyPolicyIssue = issue?.name?.toString().trim() || 'Maintenance issue';
		urgencyPolicyMatchingId = null;
		urgencyPolicyError = '';
		showUrgencyPolicyPrompt = true;
		const workspaceId = issue?.workspace_id ?? issue?.workspaceId ?? null;
		if (!workspaceId) return;
		urgencyPolicyLoading = true;
		try {
			const { data } = await supabase
				.from('workspace_policies')
				.select('id, meta, description')
				.eq('workspace_id', workspaceId)
				.eq('type', 'urgency')
				.order('updated_at', { ascending: false });
			const target = normalizePolicyLabel(urgencyPolicyIssue);
			const match = (data ?? []).find((row) => {
				const candidate = row?.meta?.maintenance_issue ?? row?.description ?? '';
				return normalizePolicyLabel(candidate) === target;
			});
			urgencyPolicyMatchingId = match?.id ?? null;
		} catch {
			urgencyPolicyError = 'Unable to load policies.';
		} finally {
			urgencyPolicyLoading = false;
		}
	};

	const closeUrgencyPolicyPrompt = () => {
		showUrgencyPolicyPrompt = false;
		urgencyPolicyError = '';
	};

	const saveUrgencyPolicy = async () => {
		if (!urgencyPolicyIssue.trim()) {
			urgencyPolicyError = 'Maintenance issue is required.';
			return;
		}
		urgencyPolicyLoading = true;
		urgencyPolicyError = '';
		try {
			const response = await fetch('/api/policies', {
				method: urgencyPolicyMatchingId ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: urgencyPolicyMatchingId,
					workspace: $page.params.workspace,
					type: 'urgency',
					urgency: urgencyPolicyValue,
					maintenance_issue: urgencyPolicyIssue.trim(),
					email: null,
					description: null
				})
			});
			const result = await response.json();
			if (!response.ok) {
				urgencyPolicyError = result?.error ?? 'Unable to save policy.';
				return;
			}
			closeUrgencyPolicyPrompt();
		} catch {
			urgencyPolicyError = 'Unable to save policy.';
		} finally {
			urgencyPolicyLoading = false;
		}
	};

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

	const collectMessagesForIssue = (mbi, id) => {
		const messages = mbi[id] ?? [];
		return [...messages].sort((a, b) => {
			const timeA = a?.timestamp ? new Date(a.timestamp).getTime() : 0;
			const timeB = b?.timestamp ? new Date(b.timestamp).getTime() : 0;
			return timeA - timeB;
		});
	};

	// Convert "Lastname, Firstname M." → "Firstname M. Lastname"
	const formatTenantName = (name) => {
		if (!name) return name;
		const comma = name.indexOf(',');
		if (comma === -1) return name;
		const last = name.slice(0, comma).trim();
		const first = name.slice(comma + 1).trim();
		return first ? `${first} ${last}` : last;
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
		const messages = collectMessagesForIssue(messagesByIssue, id);
		const messageSubject = messages.find((msg) => msg?.subject)?.subject ?? '';
		const draftSubject = (draftsByIssue[id] ?? []).find((draft) => draft?.subject)?.subject ?? '';
		return messageSubject || draftSubject || '';
	};

	let subIssuesOpen = true;
	let tasksOpen = {};
	let activityOpen = {};
	const toggleTasks = (id) => {
		tasksOpen = { ...tasksOpen, [id]: !(tasksOpen[id] ?? true) };
	};
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
		const toTitle = encodeURIComponent(subIssue.name ?? '');
		return `/${$page.params.workspace}/issue/${readableId}/${slug}?fromIssueId=${fromId}&fromIssueSlug=${fromSlug}&fromIssueTitle=${fromTitle}&toIssueTitle=${toTitle}`;
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

	let _issueChannel = null;
	let _subIssueChannel = null;

	const mergeSubIssue = (current, next) => {
		const nextAssigneeId = next?.assignee_id ?? next?.assigneeId ?? null;
		return {
			...current,
			id: next?.id ?? current?.id,
			name: next?.name ?? current?.name,
			status: next?.status ?? current?.status,
			assigneeId: nextAssigneeId ?? current?.assigneeId ?? current?.assignee_id ?? null,
			assignee_id: nextAssigneeId ?? current?.assignee_id ?? current?.assigneeId ?? null,
			parent_id: next?.parent_id ?? current?.parent_id ?? issueId,
			issueNumber: next?.issue_number ?? next?.issueNumber ?? current?.issueNumber ?? null,
			readableId: next?.readable_id ?? next?.readableId ?? current?.readableId ?? null,
			recommended_vendors: next?.recommended_vendors ?? current?.recommended_vendors ?? []
		};
	};

	const applySubIssueDelta = (next) => {
		if (!next?.id) return;
		const updated = subIssues.some((s) => s.id === next.id)
			? subIssues.map((s) => (s.id === next.id ? mergeSubIssue(s, next) : s))
			: [...subIssues, mergeSubIssue(null, next)];
		subIssues = sortSubIssues(updated);
		if (Array.isArray(_resolvedSubIssues)) {
			const resolvedUpdated = _resolvedSubIssues.some((s) => s.id === next.id)
				? _resolvedSubIssues.map((s) => (s.id === next.id ? mergeSubIssue(s, next) : s))
				: [..._resolvedSubIssues, mergeSubIssue(null, next)];
			_resolvedSubIssues = sortSubIssues(resolvedUpdated);
		}
	};

	const applyIssueDelta = (next) => {
		if (!next?.id) return;
		const nextAssigneeId = next.assignee_id ?? null;
		issue = {
			...issue,
			id: next.id ?? issue?.id,
			name: next.name ?? issue?.name,
			description: next.description ?? issue?.description ?? null,
			status: next.status ?? issue?.status,
			urgent: typeof next.urgent === 'boolean' ? next.urgent : (issue?.urgent ?? false),
			assignee_id: nextAssigneeId,
			assigneeId: nextAssigneeId,
			property_id: next.property_id ?? issue?.property_id ?? issue?.propertyId ?? null,
			propertyId: next.property_id ?? issue?.property_id ?? issue?.propertyId ?? null,
			unit_id: next.unit_id ?? issue?.unit_id ?? issue?.unitId ?? null,
			unitId: next.unit_id ?? issue?.unit_id ?? issue?.unitId ?? null,
			updated_at: next.updated_at ?? issue?.updated_at ?? null
		};
		issueAssigneeId = nextAssigneeId;
		if ((assignee?.id ?? null) !== nextAssigneeId) assignee = null;
	};

	$: if (browser && issueId) {
		if (_issueChannel) supabase.removeChannel(_issueChannel);
		_issueChannel = supabase
			.channel(`issue-${issueId}`)
			.on(
				'postgres_changes',
				{ event: 'UPDATE', schema: 'public', table: 'issues', filter: `id=eq.${issueId}` },
				(payload) => {
					if (payload?.new) applyIssueDelta(payload.new);
				}
			)
			.subscribe();

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
						if (Array.isArray(_resolvedSubIssues)) {
							_resolvedSubIssues = sortSubIssues([..._resolvedSubIssues, sub]);
						}

						// Catch-up: fetch any messages/drafts/logs written before the channel subscribes
						const [{ data: msgs }, { data: drafts }] = await Promise.all([
							supabase
								.from('messages')
								.select('id, issue_id, message, sender, subject, timestamp, direction, channel')
								.eq('issue_id', newSub.id),
							supabase
								.from('drafts')
								.select(
									'id, issue_id, message_id, sender_email, recipient_email, recipient_emails, subject, body, updated_at, channel'
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
			.on(
				'postgres_changes',
				{ event: 'UPDATE', schema: 'public', table: 'issues', filter: `parent_id=eq.${issueId}` },
				({ new: updatedSub }) => {
					if (updatedSub) applySubIssueDelta(updatedSub);
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
					{ event: '*', schema: 'public', table: 'drafts', filter: `issue_id=eq.${id}` },
					(payload) => {
						if (payload.eventType === 'DELETE') {
							removeDraft(payload.old);
						} else {
							upsertDraft(payload.new);
						}
					}
				)
				.on(
					'postgres_changes',
					{ event: '*', schema: 'public', table: 'activity_logs', filter: `issue_id=eq.${id}` },
					(payload) => {
						if (payload.eventType === 'DELETE') {
							removeActivityLogFromCache(payload.old);
						} else {
							applyActivityLogDelta(payload.new);
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
		if (_issueChannel) supabase.removeChannel(_issueChannel);
		if (_subIssueChannel) supabase.removeChannel(_subIssueChannel);
		if (browser && handleViewport) {
			window.removeEventListener('resize', handleViewport);
			window.removeEventListener('scroll', handleViewport, true);
		}
		pageReady.set(true);
	});

	// ── Navigation ───────────────────────────────────────────────────────────────

	$: fromParam = $page.url.searchParams.get('from');
	$: fromIssueId = $page.url.searchParams.get('fromIssueId');
	$: fromIssueSlug = $page.url.searchParams.get('fromIssueSlug');
	$: fromIssueTitle = $page.url.searchParams.get('fromIssueTitle');
	$: toIssueTitle = $page.url.searchParams.get('toIssueTitle');
	// Only use issueName when the loaded issue matches the current URL — if it's
	// stale from the previous page it would briefly show the wrong title.
	$: breadcrumbIssueName =
		(issue?.readableId === $page.params.issue_id ? issueName : null) || toIssueTitle || '';

	$: backHref = fromIssueId
		? `/${$page.params.workspace}/issue/${fromIssueId}/${fromIssueSlug}?toIssueTitle=${encodeURIComponent(fromIssueTitle ?? '')}`
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
		if (propertyOpen) propertyOpen = false;
		if (unitOpen) unitOpen = false;
		if (urgentOpen) urgentOpen = false;
	}
</script>

<svelte:window on:keydown={onKeydown} on:click={onWindowClick} />

{#if issue || _issueLoading}
	<div class="flex h-full">
		<div class="flex min-h-0 min-w-0 flex-1 flex-col">
			<div
				class="hidden items-center justify-between border-b border-neutral-200 px-6 py-2 text-sm text-neutral-600 sm:flex"
			>
				<div
					class="flex items-center gap-2 transition-opacity duration-150"
					class:opacity-0={!$pageReady}
				>
					<a href={backHref} class="text-neutral-700 hover:underline">{backLabel}</a>
					<span class="text-neutral-300">›</span>
					<span class="text-neutral-400">{issueReadableId ?? issueKey}</span>
					{#if _issueLoading && !breadcrumbIssueName}
						<span class="h-3.5 w-24 animate-pulse rounded bg-neutral-200"></span>
					{:else}
						<div class="flex items-center gap-2">
							<span class="text-neutral-900">{breadcrumbIssueName}</span>
							<div class="tooltip-target relative">
								<button
									type="button"
									class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100"
									on:click={copyIssueLink}
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
								<div
									class="delayed-tooltip absolute top-full left-0 z-10 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
								>
									Copy issue link
								</div>
							</div>
						</div>
					{/if}
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
						class="hidden h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 sm:inline-flex"
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
						class="hidden h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 sm:inline-flex"
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
					<div class="hidden sm:flex">
						<SidebarButton onClick={toggleChatPanel} />
					</div>
				</div>
			</div>

			<div class="min-h-0 flex-1 overflow-visible" class:opacity-0={!$pageReady}>
				<div
					class="h-full overflow-y-auto px-4 pt-4 pb-20 transition-opacity duration-200 sm:px-10 sm:pt-8"
				>
					<div class="mt-2 sm:flex sm:gap-6">
						<div
							class={`min-w-0 ${$rightPanel?.open && $rightPanel?.type === 'chat' ? 'sm:w-1/2' : 'sm:w-2/3'}`}
						>
							{#if !_issueLoading && issue}
								<h1 class="text-2xl font-semibold text-neutral-900">{issueName}</h1>
								<div class="mt-2 text-sm text-neutral-500">
									{issueDescription || 'Add description...'}
								</div>
							{:else}
								<div class="h-7 w-56 animate-pulse rounded bg-neutral-200"></div>
								<div class="mt-2 h-4 w-80 animate-pulse rounded bg-neutral-100"></div>
							{/if}
							<div class="mt-4 sm:hidden">
								<div class="rounded-2xl">
									<div class="space-y-2 text-sm text-neutral-600">
										<div class="grid grid-cols-2 gap-1">
											<div class="tooltip-target relative">
												<button
													type="button"
													bind:this={propertyAnchorMobile}
													class={`flex w-full items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
														canEditIssue ? 'hover:bg-neutral-200' : 'cursor-default opacity-60'
													}`}
													disabled={!canEditIssue}
													aria-disabled={!canEditIssue}
													on:click|stopPropagation={() => {
														if (!canEditIssue) return;
														propertyOpen = !propertyOpen;
														unitOpen = false;
														statusOpen = false;
														assigneeOpen = false;
														urgentOpen = false;
														urgentHelpOpen = false;
														if (propertyOpen) refreshOpenFieldMenus();
													}}
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="14"
														height="14"
														fill="currentColor"
														class="text-neutral-400"
														viewBox="0 0 16 16"
													>
														<path
															d="M3 0a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V16h3a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1zm1 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5M4 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM7.5 5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM4.5 8h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5"
														/>
													</svg>
													<span class="truncate text-neutral-700">{propertyName}</span>
												</button>
												{#if !rightSidebarMenuOpen}
													<div
														class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														Change property
													</div>
												{/if}
												{#if propertyOpen && canEditIssue}
													<div
														class="fixed z-[100] w-56 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
														style={propertyMenuStyle}
														on:click|stopPropagation
													>
														<button
															type="button"
															class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																!issuePropertyId ? 'bg-neutral-50' : ''
															}`}
															on:click={() => handlePropertySelect(null)}
														>
															<span>No property</span>
															{#if !issuePropertyId}
																<span class="text-xs text-neutral-400">Selected</span>
															{/if}
														</button>
														<div class="my-1 h-px bg-neutral-100"></div>
														{#each properties as property}
															<button
																type="button"
																class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																	issuePropertyId === property.id ? 'bg-neutral-50' : ''
																}`}
																on:click={() => handlePropertySelect(property.id)}
															>
																<span class="truncate">{property.name}</span>
																{#if issuePropertyId === property.id}
																	<span class="text-xs text-neutral-400">Selected</span>
																{/if}
															</button>
														{/each}
													</div>
												{/if}
											</div>
											<div class="tooltip-target relative">
												<button
													type="button"
													bind:this={unitAnchorMobile}
													class={`flex w-full items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
														canEditIssue ? 'hover:bg-neutral-200' : 'cursor-default opacity-60'
													}`}
													disabled={!canEditIssue}
													aria-disabled={!canEditIssue}
													on:click|stopPropagation={() => {
														if (!canEditIssue) return;
														unitOpen = !unitOpen;
														propertyOpen = false;
														statusOpen = false;
														assigneeOpen = false;
														urgentOpen = false;
														urgentHelpOpen = false;
														if (unitOpen) refreshOpenFieldMenus();
													}}
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="14"
														height="14"
														fill="currentColor"
														class="text-neutral-400"
														viewBox="0 0 16 16"
													>
														<path
															d="M6.5 14.5v-3.505c0-.245.25-.495.5-.495h2c.25 0 .5.25.5.5v3.5a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.146-.354L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293L8.354 1.146a.5.5 0 0 0-.708 0l-6 6A.5.5 0 0 0 1.5 7.5v7a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5"
														/>
													</svg>
													<span class="truncate text-neutral-700">{unitName}</span>
												</button>
												{#if !rightSidebarMenuOpen}
													<div
														class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														Change unit
													</div>
												{/if}
												{#if unitOpen && canEditIssue}
													<div
														class="fixed z-[100] w-56 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
														style={unitMenuStyle}
														on:click|stopPropagation
													>
														<button
															type="button"
															class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																!issueUnitId ? 'bg-neutral-50' : ''
															}`}
															on:click={() => handleUnitSelect(null)}
														>
															<span>No unit</span>
															{#if !issueUnitId}
																<span class="text-xs text-neutral-400">Selected</span>
															{/if}
														</button>
														<div class="my-1 h-px bg-neutral-100"></div>
														{#if availableUnits.length}
															{#each availableUnits as unit}
																<button
																	type="button"
																	class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																		issueUnitId === unit.id ? 'bg-neutral-50' : ''
																	}`}
																	on:click={() => handleUnitSelect(unit.id)}
																>
																	<span class="truncate">{unit.name}</span>
																	{#if issueUnitId === unit.id}
																		<span class="text-xs text-neutral-400">Selected</span>
																	{/if}
																</button>
															{/each}
														{:else}
															<div class="px-3 py-2 text-neutral-400">No units available.</div>
														{/if}
													</div>
												{/if}
											</div>
										</div>
										<div class="grid grid-cols-2 gap-2">
											<div class="tooltip-target relative">
												<button
													type="button"
													bind:this={statusAnchorMobile}
													class={`flex w-full items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
														canEditIssue ? 'hover:bg-neutral-200' : 'cursor-default opacity-60'
													}`}
													disabled={!canEditIssue}
													aria-disabled={!canEditIssue}
													on:click|stopPropagation={() => {
														if (!canEditIssue) return;
														statusOpen = !statusOpen;
														propertyOpen = false;
														unitOpen = false;
														assigneeOpen = false;
														urgentOpen = false;
														urgentHelpOpen = false;
														if (statusOpen) refreshOpenFieldMenus();
													}}
												>
													<span
														class={`h-3.5 w-3.5 rounded-full border-[1.5px] ${statusMeta.statusClass}`}
													></span>
													<span>{statusMeta.label}</span>
												</button>
												{#if !rightSidebarMenuOpen}
													<div
														class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														Change status
													</div>
												{/if}
												{#if statusOpen && canEditIssue}
													<div
														class="fixed z-[100] w-48 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
														style={statusMenuStyle}
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
																	class={`h-4 w-4 rounded-full border-[1.5px] ${
																		(statusConfig[status] ?? statusConfig.todo).statusClass
																	}`}
																></span>
																<span>{(statusConfig[status] ?? statusConfig.todo).label}</span>
															</button>
														{/each}
													</div>
												{/if}
											</div>
											<div class="tooltip-target relative">
												<button
													type="button"
													bind:this={assigneeAnchorMobile}
													class={`flex w-full items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
														canEditIssue ? 'hover:bg-neutral-200' : 'cursor-default opacity-60'
													}`}
													disabled={!canEditIssue}
													aria-disabled={!canEditIssue}
													on:click|stopPropagation={() => {
														if (!canEditIssue) return;
														assigneeOpen = !assigneeOpen;
														propertyOpen = false;
														unitOpen = false;
														statusOpen = false;
														urgentOpen = false;
														urgentHelpOpen = false;
														if (assigneeOpen) refreshOpenFieldMenus();
													}}
												>
													{#if assignee}
														<div
															class={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${getAssigneeAvatar(assignee).color}`}
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
												{#if !rightSidebarMenuOpen}
													<div
														class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														Change assignee
													</div>
												{/if}
												{#if assigneeOpen && canEditIssue}
													<div
														class="fixed z-[100] w-56 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
														style={assigneeMenuStyle}
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
																		class={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${getMemberAvatar(member).color}`}
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
										<div class="tooltip-target group relative">
											<button
												type="button"
												bind:this={urgentAnchorMobile}
												class={`flex w-1/2 items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
													canEditIssue && !isSubissue
														? 'hover:bg-neutral-200'
														: 'cursor-not-allowed opacity-60'
												}`}
												disabled={!canEditIssue || isSubissue}
												aria-disabled={!canEditIssue || isSubissue}
												on:click|stopPropagation={() => {
													if (!canEditIssue || isSubissue) return;
													urgentOpen = !urgentOpen;
													urgentHelpOpen = false;
													statusOpen = false;
													assigneeOpen = false;
													propertyOpen = false;
													unitOpen = false;
													if (urgentOpen) refreshOpenFieldMenus();
												}}
											>
												{#if displayUrgent}
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="16"
														height="16"
														fill="currentColor"
														class="text-rose-600"
														viewBox="0 0 16 16"
													>
														<path
															d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm6 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
														/>
													</svg>
													<span>Urgent</span>
												{:else}
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="16"
														height="16"
														fill="currentColor"
														class="text-neutral-400"
														viewBox="0 0 16 16"
													>
														<path
															d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm2.5 7.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1"
														/>
													</svg>
													<span>Not urgent</span>
												{/if}
											</button>
											{#if !rightSidebarMenuOpen}
												<div
													class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
												>
													{isSubissue ? 'Change urgency in the root issue' : 'Change urgency'}
												</div>
											{/if}
											{#if urgentOpen && canEditIssue && !isSubissue}
												<div
													class="fixed z-[100] w-48 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
													style={urgentMenuStyle}
													on:click|stopPropagation
												>
													<button
														type="button"
														class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
															displayUrgent ? 'bg-neutral-50' : ''
														}`}
														on:click={() => handleUrgentChange(true)}
													>
														<svg
															xmlns="http://www.w3.org/2000/svg"
															width="16"
															height="16"
															fill="currentColor"
															class="text-rose-600"
															viewBox="0 0 16 16"
														>
															<path
																d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm6 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
															/>
														</svg>
														<span>Urgent</span>
													</button>
													<button
														type="button"
														class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
															!displayUrgent ? 'bg-neutral-50' : ''
														}`}
														on:click={() => handleUrgentChange(false)}
													>
														<svg
															xmlns="http://www.w3.org/2000/svg"
															width="16"
															height="16"
															fill="currentColor"
															class="text-neutral-400"
															viewBox="0 0 16 16"
														>
															<path
																d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm2.5 7.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1"
															/>
														</svg>
														<span>Not urgent</span>
													</button>
												</div>
											{/if}
										</div>
									</div>
								</div>
							</div>
							<div class="mt-4 min-w-0">
								{#if !_subIssuesLoading && subIssues.length}
									<div>
										<button
											type="button"
											class="tooltip-target relative ml-0.5 flex w-full cursor-pointer items-center justify-between text-xs font-medium tracking-wide text-neutral-500 hover:text-neutral-700"
											on:click={() => (subIssuesOpen = !subIssuesOpen)}
										>
											<div
												class="flex items-center gap-2 rounded-md px-0 py-1.5 transition select-none hover:text-neutral-700"
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="12"
													height="12"
													fill="currentColor"
													class="chevron-icon transition-transform duration-150 ease-in-out"
													class:rotate-[-90deg]={!subIssuesOpen}
													viewBox="0 0 16 16"
												>
													<path
														d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
													/>
												</svg>
												<span>Sub-issues</span>
											</div>
											<div
												class="delayed-tooltip absolute top-full left-0 z-10 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
											>
												{subIssuesOpen ? 'Collapse' : 'Expand'}
											</div>
										</button>
										<div
											class="grid transition-[grid-template-rows] duration-150 ease-in-out"
											style:grid-template-rows={subIssuesOpen ? '1fr' : '0fr'}
										>
											<div class="overflow-hidden">
												<div class="mt-2">
													{#each subIssuesWithAssignees as subIssue}
														<a
															href={getSubIssueHref(subIssue)}
															class="relative flex items-center justify-between px-3 py-3 text-sm transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-200 focus-visible:outline-none"
															on:mouseenter={(event) => {
																subIssueHoverId = subIssue.id;
																subIssueTooltipVisible = true;
																const rect = event.currentTarget.getBoundingClientRect();
																subIssueTooltipX = event.clientX + 12;
																subIssueTooltipY = rect.bottom + 8;
															}}
															on:mousemove={(event) => {
																subIssueTooltipX = event.clientX + 12;
															}}
															on:mouseleave={() => {
																subIssueTooltipVisible = false;
																subIssueHoverId = null;
															}}
														>
															<div class="flex items-center gap-2">
																<span
																	class={`h-4 w-4 rounded-full border-[1.5px] ${
																		statusConfig[subIssue.status ?? 'todo']?.statusClass ??
																		'border-neutral-300 text-neutral-700'
																	}`}
																></span>
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
															{#if subIssueTooltipVisible && subIssueHoverId === subIssue.id}
																<div
																	class="subissue-hover-tooltip fixed z-50 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
																	style={`left: ${subIssueTooltipX}px; top: ${subIssueTooltipY}px;`}
																>
																	Go to issue
																</div>
															{/if}
														</a>
													{/each}
												</div>
											</div>
										</div>
									</div>
								{/if}
							</div>
						</div>
						<div class={`${$rightPanel?.open && $rightPanel?.type === 'chat' ? 'w-1/2' : 'w-1/3'}`}>
							<div class="hidden sm:block">
								<div class="rounded-2xl">
									<span class="text-sm font-medium text-neutral-500">Fields</span>
									<div class="mt-1 space-y-2 text-sm text-neutral-600">
										<div class="grid grid-cols-2 gap-2">
											<div class="tooltip-target relative">
												<button
													type="button"
													class={`flex w-full items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
														canEditIssue ? 'hover:bg-neutral-200' : 'cursor-default opacity-60'
													}`}
													disabled={!canEditIssue}
													aria-disabled={!canEditIssue}
													on:click|stopPropagation={() => {
														if (!canEditIssue) return;
														propertyOpen = !propertyOpen;
														unitOpen = false;
														statusOpen = false;
														assigneeOpen = false;
														urgentOpen = false;
														urgentHelpOpen = false;
													}}
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="14"
														height="14"
														fill="currentColor"
														class="text-neutral-400"
														viewBox="0 0 16 16"
													>
														<path
															d="M3 0a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V16h3a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1zm1 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5M4 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM7.5 5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM4.5 8h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5"
														/>
													</svg>
													<span class="truncate text-neutral-700">{propertyName}</span>
												</button>
												{#if !rightSidebarMenuOpen}
													<div
														class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														Change property
													</div>
												{/if}
												{#if propertyOpen && canEditIssue}
													<div
														class={`absolute ${fieldsDesktopAlignClass} z-10 mt-2 w-56 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg`}
														on:click|stopPropagation
													>
														<button
															type="button"
															class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																!issuePropertyId ? 'bg-neutral-50' : ''
															}`}
															on:click={() => handlePropertySelect(null)}
														>
															<span>No property</span>
															{#if !issuePropertyId}
																<span class="text-xs text-neutral-400">Selected</span>
															{/if}
														</button>
														<div class="my-1 h-px bg-neutral-100"></div>
														{#each properties as property}
															<button
																type="button"
																class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																	issuePropertyId === property.id ? 'bg-neutral-50' : ''
																}`}
																on:click={() => handlePropertySelect(property.id)}
															>
																<span class="truncate">{property.name}</span>
																{#if issuePropertyId === property.id}
																	<span class="text-xs text-neutral-400">Selected</span>
																{/if}
															</button>
														{/each}
													</div>
												{/if}
											</div>
											<div class="tooltip-target relative">
												<button
													type="button"
													class={`flex w-full items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
														canEditIssue ? 'hover:bg-neutral-200' : 'cursor-default opacity-60'
													}`}
													disabled={!canEditIssue}
													aria-disabled={!canEditIssue}
													on:click|stopPropagation={() => {
														if (!canEditIssue) return;
														unitOpen = !unitOpen;
														propertyOpen = false;
														statusOpen = false;
														assigneeOpen = false;
														urgentOpen = false;
														urgentHelpOpen = false;
													}}
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="14"
														height="14"
														fill="currentColor"
														class="text-neutral-400"
														viewBox="0 0 16 16"
													>
														<path
															d="M6.5 14.5v-3.505c0-.245.25-.495.5-.495h2c.25 0 .5.25.5.5v3.5a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.146-.354L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293L8.354 1.146a.5.5 0 0 0-.708 0l-6 6A.5.5 0 0 0 1.5 7.5v7a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5"
														/>
													</svg>
													<span class="truncate text-neutral-700">{unitName}</span>
												</button>
												{#if !rightSidebarMenuOpen}
													<div
														class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														Change unit
													</div>
												{/if}
												{#if unitOpen && canEditIssue}
													<div
														class={`absolute ${fieldsDesktopAlignClass} z-10 mt-2 w-56 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg`}
														on:click|stopPropagation
													>
														<button
															type="button"
															class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																!issueUnitId ? 'bg-neutral-50' : ''
															}`}
															on:click={() => handleUnitSelect(null)}
														>
															<span>No unit</span>
															{#if !issueUnitId}
																<span class="text-xs text-neutral-400">Selected</span>
															{/if}
														</button>
														<div class="my-1 h-px bg-neutral-100"></div>
														{#if availableUnits.length}
															{#each availableUnits as unit}
																<button
																	type="button"
																	class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																		issueUnitId === unit.id ? 'bg-neutral-50' : ''
																	}`}
																	on:click={() => handleUnitSelect(unit.id)}
																>
																	<span class="truncate">{unit.name}</span>
																	{#if issueUnitId === unit.id}
																		<span class="text-xs text-neutral-400">Selected</span>
																	{/if}
																</button>
															{/each}
														{:else}
															<div class="px-3 py-2 text-neutral-400">No units available.</div>
														{/if}
													</div>
												{/if}
											</div>
										</div>
										<div class="grid grid-cols-2 gap-2">
											<div class="tooltip-target relative">
												<button
													type="button"
													class={`flex w-full items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
														canEditIssue ? 'hover:bg-neutral-200' : 'cursor-default opacity-60'
													}`}
													disabled={!canEditIssue}
													aria-disabled={!canEditIssue}
													on:click|stopPropagation={() => {
														if (!canEditIssue) return;
														statusOpen = !statusOpen;
														propertyOpen = false;
														unitOpen = false;
														assigneeOpen = false;
														urgentOpen = false;
														urgentHelpOpen = false;
													}}
												>
													<span
														class={`h-4 w-4 rounded-full border-[1.5px] ${statusMeta.statusClass}`}
													></span>
													<span>{statusMeta.label}</span>
												</button>
												{#if !rightSidebarMenuOpen}
													<div
														class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														Change status
													</div>
												{/if}
												{#if statusOpen && canEditIssue}
													<div
														class={`absolute ${fieldsDesktopAlignClass} z-10 mt-2 w-48 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg`}
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
																	class={`h-4 w-4 rounded-full border-[1.5px] ${
																		(statusConfig[status] ?? statusConfig.todo).statusClass
																	}`}
																></span>
																<span>{(statusConfig[status] ?? statusConfig.todo).label}</span>
															</button>
														{/each}
													</div>
												{/if}
											</div>
											<div class="tooltip-target relative">
												<button
													type="button"
													class={`flex w-full items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
														canEditIssue ? 'hover:bg-neutral-200' : 'cursor-default opacity-60'
													}`}
													disabled={!canEditIssue}
													aria-disabled={!canEditIssue}
													on:click|stopPropagation={() => {
														if (!canEditIssue) return;
														assigneeOpen = !assigneeOpen;
														propertyOpen = false;
														unitOpen = false;
														statusOpen = false;
														urgentOpen = false;
														urgentHelpOpen = false;
													}}
												>
													{#if assignee}
														<div
															class={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${getAssigneeAvatar(assignee).color}`}
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
													<span class="truncate text-neutral-700">{assigneeName}</span>
												</button>
												{#if !rightSidebarMenuOpen}
													<div
														class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														Change assignee
													</div>
												{/if}
												{#if assigneeOpen && canEditIssue}
													<div
														class={`absolute ${fieldsDesktopAlignClass} z-10 mt-2 w-56 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg`}
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
																		class={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${getMemberAvatar(member).color}`}
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
										<div class="flex items-center justify-between gap-2">
											<div class="tooltip-target group relative w-1/2">
												<div
													class={`flex w-full items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 transition ${
														canEditIssue && !isSubissue ? 'hover:bg-neutral-200' : 'opacity-60'
													}`}
												>
													<button
														type="button"
														class={`flex min-w-0 flex-1 items-center gap-2 text-left ${
															canEditIssue && !isSubissue ? '' : 'cursor-not-allowed'
														}`}
														disabled={!canEditIssue || isSubissue}
														aria-disabled={!canEditIssue || isSubissue}
														on:click|stopPropagation={() => {
															if (!canEditIssue || isSubissue) return;
															urgentOpen = !urgentOpen;
															urgentHelpOpen = false;
															statusOpen = false;
															assigneeOpen = false;
															propertyOpen = false;
															unitOpen = false;
														}}
													>
														{#if displayUrgent}
															<svg
																xmlns="http://www.w3.org/2000/svg"
																width="16"
																height="16"
																fill="currentColor"
																class="text-rose-600"
																viewBox="0 0 16 16"
															>
																<path
																	d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm6 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
																/>
															</svg>
															<span>Urgent</span>
														{:else}
															<svg
																xmlns="http://www.w3.org/2000/svg"
																width="16"
																height="16"
																fill="currentColor"
																class="text-neutral-400"
																viewBox="0 0 16 16"
															>
																<path
																	d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm2.5 7.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1"
																/>
															</svg>
															<span>Not urgent</span>
														{/if}
													</button>
													<div class="relative ml-auto">
														<button
															type="button"
															class="inline-flex h-5 w-5 items-center justify-center rounded-full text-neutral-400 transition hover:text-neutral-600"
															aria-label="Urgent issue help"
															aria-expanded={urgentHelpOpen}
															on:click|stopPropagation={() => {
																urgentOpen = false;
																urgentHelpOpen = !urgentHelpOpen;
																propertyOpen = false;
																unitOpen = false;
																statusOpen = false;
																assigneeOpen = false;
															}}
															on:blur={() => (urgentHelpOpen = false)}
														>
															<svg
																xmlns="http://www.w3.org/2000/svg"
																width="16"
																height="16"
																fill="currentColor"
																class="bi bi-question-circle"
																viewBox="0 0 16 16"
															>
																<path
																	d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"
																/>
																<path
																	d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286m1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94"
																/>
															</svg>
														</button>
														{#if urgentHelpOpen}
															<div
																class="absolute top-full right-0 z-30 mt-2 min-w-[260px] rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs leading-snug text-neutral-700 shadow-sm"
															>
																Bedrock immediately assigns a vendor for urgent issues.
															</div>
														{/if}
													</div>
												</div>
												{#if !rightSidebarMenuOpen}
													<div
														class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														{isSubissue ? 'Change urgency in the root issue' : 'Change urgency'}
													</div>
												{/if}
												{#if urgentOpen && canEditIssue && !isSubissue}
													<div
														class={`absolute ${fieldsDesktopAlignClass} z-10 mt-2 w-48 rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg`}
														on:click|stopPropagation
													>
														<button
															type="button"
															class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																displayUrgent ? 'bg-neutral-50' : ''
															}`}
															on:click={() => handleUrgentChange(true)}
														>
															<svg
																xmlns="http://www.w3.org/2000/svg"
																width="16"
																height="16"
																fill="currentColor"
																class="text-rose-600"
																viewBox="0 0 16 16"
															>
																<path
																	d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm6 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
																/>
															</svg>
															<span>Urgent</span>
														</button>
														<button
															type="button"
															class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																!displayUrgent ? 'bg-neutral-50' : ''
															}`}
															on:click={() => handleUrgentChange(false)}
														>
															<svg
																xmlns="http://www.w3.org/2000/svg"
																width="16"
																height="16"
																fill="currentColor"
																class="text-neutral-400"
																viewBox="0 0 16 16"
															>
																<path
																	d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm2.5 7.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1"
																/>
															</svg>
															<span>Not urgent</span>
														</button>
													</div>
												{/if}
											</div>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>

					<div class="mt-4 border-t border-neutral-100 pt-4 sm:mt-8 sm:pt-6">
						<div class="flex items-center justify-between">
							<h2 class="text-base font-semibold text-neutral-800">Tasks</h2>
							<div class="text-sm text-neutral-400">Unsubscribe</div>
						</div>
						{#if !hasTasks}
							<div class="mt-4 text-sm text-neutral-500">No tasks yet.</div>
						{:else}
							<div class="mt-4 space-y-4 text-sm">
								{#if (draftsByIssue[issueId]?.length ?? 0) > 0}
									{#if (messagesByIssue[issueId]?.length ?? 0) > 0 || (replyDraftsByIssue[issueId]?.length ?? 0) > 0}
										<div class="space-y-3">
											{#if getThreadSubject(issueId)}
												<div class="flex items-center gap-2">
													<div class="flex items-center justify-center">
														{#if (messagesByIssue[issueId] ?? []).some((m) => m.channel === 'appfolio')}
															<svg
																class="h-7 w-7"
																viewBox="0 0 1024 1024"
																fill="none"
																xmlns="http://www.w3.org/2000/svg"
															>
																<circle cx="512" cy="512" r="512" fill="#007bc7" />
																<g transform="translate(512,512) scale(1.25) translate(-512,-512)">
																	<path
																		d="M582.49 516a77.29 77.29 0 0 0 15.31-4.9v31.72c0 69.9-67.12 85.21-93 85.21-35.29 0-73.3-18.75-73.3-49.15 0-32.73 29.44-43 91.33-52.48 16.08-2.4 42.3-7.06 59.66-10.4zM654.12 480.77c0-10.41-.33-20.26-.33-28.89 0-54.88-26.32-82.32-48.42-95.68a147.66 147.66 0 0 0-73.86-18.53c-54.77 0-95.12 15.42-120.05 45.75a115.6 115.6 0 0 0-24.93 62.78 9.53 9.53 0 0 0 0 1.78 29.28 29.28 0 0 0 29.55 26.55 27.27 27.27 0 0 0 29.72-23c6.35-29.5 20.43-56.83 80.59-56.83 31.89 0 52.71 6.57 63.62 20.09a39 39 0 0 1 10.19 30.28c0 10-3.79 22.26-33.39 28.78-19.2 4.17-39.41 6.51-58.94 8.74l-9.35 1.11c-110.77 13.1-127.47 71.54-127.47 105.16 0 61 73.36 95.51 126.34 97.18h9.8a153.19 153.19 0 0 0 58.66-10.3l1.61-.67a136.14 136.14 0 0 0 79.59-81c8.63-23.25 7.85-71.07 7.07-113.3z"
																		fill="white"
																	/>
																</g>
															</svg>
														{:else if (messagesByIssue[issueId] ?? []).some((m) => m.channel === 'appfolio')}
															<svg
																class="h-7 w-7"
																viewBox="0 0 1024 1024"
																fill="none"
																xmlns="http://www.w3.org/2000/svg"
															>
																<circle cx="512" cy="512" r="512" fill="#007bc7" />
																<g transform="translate(512,512) scale(1.25) translate(-512,-512)">
																	<path
																		d="M582.49 516a77.29 77.29 0 0 0 15.31-4.9v31.72c0 69.9-67.12 85.21-93 85.21-35.29 0-73.3-18.75-73.3-49.15 0-32.73 29.44-43 91.33-52.48 16.08-2.4 42.3-7.06 59.66-10.4zM654.12 480.77c0-10.41-.33-20.26-.33-28.89 0-54.88-26.32-82.32-48.42-95.68a147.66 147.66 0 0 0-73.86-18.53c-54.77 0-95.12 15.42-120.05 45.75a115.6 115.6 0 0 0-24.93 62.78 9.53 9.53 0 0 0 0 1.78 29.28 29.28 0 0 0 29.55 26.55 27.27 27.27 0 0 0 29.72-23c6.35-29.5 20.43-56.83 80.59-56.83 31.89 0 52.71 6.57 63.62 20.09a39 39 0 0 1 10.19 30.28c0 10-3.79 22.26-33.39 28.78-19.2 4.17-39.41 6.51-58.94 8.74l-9.35 1.11c-110.77 13.1-127.47 71.54-127.47 105.16 0 61 73.36 95.51 126.34 97.18h9.8a153.19 153.19 0 0 0 58.66-10.3l1.61-.67a136.14 136.14 0 0 0 79.59-81c8.63-23.25 7.85-71.07 7.07-113.3z"
																		fill="white"
																	/>
																</g>
															</svg>
														{:else}
															<svg
																class="h-[26px] w-[26px]"
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
														{/if}
													</div>
													<h3 class="text-base font-semibold text-neutral-900">
														{getThreadSubject(issueId)}
													</h3>
												</div>
											{:else if (replyDraftsByIssue[issueId]?.length ?? 0) > 0}
												<div class="flex items-center gap-2">
													{#if !(replyDraftsByIssue[issueId] ?? []).some((d) => d.channel === 'appfolio')}
														<div class="flex items-center justify-center">
															<svg
																class="h-6 w-6 text-neutral-500"
																viewBox="0 0 16 16"
																fill="currentColor"
															>
																<path
																	d="M8 3a5 5 0 1 0 4.546 2.916.5.5 0 0 0-.908-.418A4 4 0 1 1 8 4.5V6a.5.5 0 0 0 .854.354l2-2a.5.5 0 0 0 0-.708l-2-2A.5.5 0 0 0 8 2v1z"
																/>
															</svg>
														</div>
														<h3 class="text-base font-semibold text-neutral-900">Draft reply</h3>
													{:else}
														<h3 class="text-base font-semibold text-neutral-900">Drafted reply</h3>
													{/if}
												</div>
											{/if}
											<div class="space-y-3">
												{#each collectMessagesForIssue(messagesByIssue, issueId) as message}
													<EmailMessageWithDraft
														message={{
															...message,
															timestampLabel: formatTimestamp(message.timestamp)
														}}
														draft={null}
													/>
												{/each}
												{#each replyDraftsByIssue[issueId] ?? [] as draft}
													{#if draft.channel === 'appfolio'}
														<AppfolioDraftMessage
															message={{
																id: draft.message_id,
																subject: draft.subject,
																message: '',
																sender: 'outbound',
																direction: 'outbound',
																timestampLabel: formatTimestamp(draft.updated_at)
															}}
															{draft}
															approvedBy={getAppfolioApprovedBy(draft.issue_id)}
															{vendors}
															recommendedVendors={recommendedVendorsByIssueId[draft.issue_id] ?? []}
															on:sent={(e) => handleDraftSent(e.detail)}
															on:assigneeUpdated={(e) => handleAppfolioAssigneeUpdate(e.detail)}
														/>
													{:else}
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
															recommendedVendors={recommendedVendorsByIssueId[draft.issue_id] ?? []}
															on:sent={(e) => handleDraftSent(e.detail)}
														/>
													{/if}
												{/each}
											</div>
										</div>
									{/if}

									{#if (newDraftsByIssue[issueId]?.length ?? 0) > 0}
										<div class="space-y-3">
											<div class="flex items-center gap-2">
												{#if !(newDraftsByIssue[issueId] ?? []).some((d) => d.channel === 'appfolio')}
													<div class="flex items-center justify-center">
														<svg
															class="h-[26px] w-[26px]"
															viewBox="0 0 32 32"
															fill="none"
															xmlns="http://www.w3.org/2000/svg"
														>
															<path
																d="M2 11.9556C2 8.47078 2 6.7284 2.67818 5.39739C3.27473 4.22661 4.22661 3.27473 5.39739 2.67818C6.7284 2 8.47078 2 11.9556 2H20.0444C23.5292 2 25.2716 2 26.6026 2.67818C27.7734 3.27473 28.7253 4.22661 29.3218 5.39739C30 6.7284 30 8.47078 30 11.9556V20.0444C30 23.5292 30 25.2716 29.3218 26.6026C28.7253 27.7734 27.7734 28.7253 26.6026 29.3218C25.2716 30 23.5292 30 20.0444 30H11.9556C8.47078 30 6.7284 30 5.39739 29.3218C4.22661 28.7253 3.27473 27.7734 2.67818 26.6026C2 25.2716 2 23.5292 2 20.0444V11.9556Z"
																fill="none"
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
													<h3 class="text-base font-semibold text-neutral-900">Email drafted</h3>
												{:else}
													<svg
														class="h-7 w-7"
														viewBox="0 0 1024 1024"
														fill="none"
														xmlns="http://www.w3.org/2000/svg"
													>
														<circle cx="512" cy="512" r="512" fill="#007bc7" />
														<g transform="translate(512,512) scale(1.25) translate(-512,-512)">
															<path
																d="M582.49 516a77.29 77.29 0 0 0 15.31-4.9v31.72c0 69.9-67.12 85.21-93 85.21-35.29 0-73.3-18.75-73.3-49.15 0-32.73 29.44-43 91.33-52.48 16.08-2.4 42.3-7.06 59.66-10.4zM654.12 480.77c0-10.41-.33-20.26-.33-28.89 0-54.88-26.32-82.32-48.42-95.68a147.66 147.66 0 0 0-73.86-18.53c-54.77 0-95.12 15.42-120.05 45.75a115.6 115.6 0 0 0-24.93 62.78 9.53 9.53 0 0 0 0 1.78 29.28 29.28 0 0 0 29.55 26.55 27.27 27.27 0 0 0 29.72-23c6.35-29.5 20.43-56.83 80.59-56.83 31.89 0 52.71 6.57 63.62 20.09a39 39 0 0 1 10.19 30.28c0 10-3.79 22.26-33.39 28.78-19.2 4.17-39.41 6.51-58.94 8.74l-9.35 1.11c-110.77 13.1-127.47 71.54-127.47 105.16 0 61 73.36 95.51 126.34 97.18h9.8a153.19 153.19 0 0 0 58.66-10.3l1.61-.67a136.14 136.14 0 0 0 79.59-81c8.63-23.25 7.85-71.07 7.07-113.3z"
																fill="white"
															/>
														</g>
													</svg>
													<h3 class="text-base font-semibold text-neutral-900">
														{(newDraftsByIssue[issueId] ?? []).some((d) => d.recipient_email)
															? 'Assign Vendor'
															: 'Drafted reply'}
													</h3>
												{/if}
											</div>
											<div class="space-y-3">
												{#each newDraftsByIssue[issueId] ?? [] as draft}
													{#if draft.channel === 'appfolio'}
														<AppfolioDraftMessage
															message={{
																id: draft.message_id,
																subject: draft.subject,
																message: '',
																sender: 'outbound',
																direction: 'outbound',
																timestampLabel: formatTimestamp(draft.updated_at)
															}}
															{draft}
															approvedBy={getAppfolioApprovedBy(draft.issue_id)}
															{vendors}
															recommendedVendors={recommendedVendorsByIssueId[draft.issue_id] ?? []}
															on:sent={(e) => handleDraftSent(e.detail)}
															on:assigneeUpdated={(e) => handleAppfolioAssigneeUpdate(e.detail)}
														/>
													{:else}
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
															recommendedVendors={recommendedVendorsByIssueId[draft.issue_id] ?? []}
															on:sent={(e) => handleDraftSent(e.detail)}
														/>
													{/if}
												{/each}
											</div>
										</div>
									{/if}
								{/if}

								{#each subIssues as subIssue}
									{#if (draftsByIssue[subIssue.id]?.length ?? 0) > 0}
										<div>
											<button
												type="button"
												class="tooltip-target relative ml-0.5 flex w-full cursor-pointer items-center justify-between text-xs font-medium tracking-wide text-neutral-500 hover:text-neutral-700"
												on:click={() => toggleTasks(subIssue.id)}
											>
												<div
													class="flex items-center gap-2 rounded-md px-0 py-1.5 transition select-none hover:text-neutral-700"
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="12"
														height="12"
														fill="currentColor"
														class="chevron-icon transition-transform duration-150 ease-in-out"
														class:rotate-[-90deg]={!(tasksOpen[subIssue.id] ?? true)}
														viewBox="0 0 16 16"
													>
														<path
															d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
														/>
													</svg>
													<span>{subIssue.name}</span>
												</div>
												<div
													class="delayed-tooltip absolute top-full left-0 z-10 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
												>
													{(tasksOpen[subIssue.id] ?? true) ? 'Collapse' : 'Expand'}
												</div>
												<span class="text-neutral-300">
													{draftsByIssue[subIssue.id]?.length ?? 0}
												</span>
											</button>
											<div
												class="grid transition-[grid-template-rows] duration-200 ease-in-out"
												style:grid-template-rows={(tasksOpen[subIssue.id] ?? true) ? '1fr' : '0fr'}
											>
												<div class="overflow-hidden">
													<div
														class="space-y-3 py-2 transition-opacity duration-200"
														class:opacity-0={!(tasksOpen[subIssue.id] ?? true)}
													>
														{#if (messagesByIssue[subIssue.id]?.length ?? 0) > 0 || (replyDraftsByIssue[subIssue.id]?.length ?? 0) > 0}
															<div class="space-y-3">
																{#if getThreadSubject(subIssue.id)}
																	<div class="flex items-center gap-2">
																		<div class="flex items-center justify-center">
																			{#if (messagesByIssue[subIssue.id] ?? []).some((m) => m.channel === 'appfolio')}
																				<svg
																					class="h-7 w-7"
																					viewBox="0 0 1024 1024"
																					fill="none"
																					xmlns="http://www.w3.org/2000/svg"
																				>
																					<circle cx="512" cy="512" r="512" fill="#007bc7" />
																					<g
																						transform="translate(512,512) scale(1.25) translate(-512,-512)"
																					>
																						<path
																							d="M582.49 516a77.29 77.29 0 0 0 15.31-4.9v31.72c0 69.9-67.12 85.21-93 85.21-35.29 0-73.3-18.75-73.3-49.15 0-32.73 29.44-43 91.33-52.48 16.08-2.4 42.3-7.06 59.66-10.4zM654.12 480.77c0-10.41-.33-20.26-.33-28.89 0-54.88-26.32-82.32-48.42-95.68a147.66 147.66 0 0 0-73.86-18.53c-54.77 0-95.12 15.42-120.05 45.75a115.6 115.6 0 0 0-24.93 62.78 9.53 9.53 0 0 0 0 1.78 29.28 29.28 0 0 0 29.55 26.55 27.27 27.27 0 0 0 29.72-23c6.35-29.5 20.43-56.83 80.59-56.83 31.89 0 52.71 6.57 63.62 20.09a39 39 0 0 1 10.19 30.28c0 10-3.79 22.26-33.39 28.78-19.2 4.17-39.41 6.51-58.94 8.74l-9.35 1.11c-110.77 13.1-127.47 71.54-127.47 105.16 0 61 73.36 95.51 126.34 97.18h9.8a153.19 153.19 0 0 0 58.66-10.3l1.61-.67a136.14 136.14 0 0 0 79.59-81c8.63-23.25 7.85-71.07 7.07-113.3z"
																							fill="white"
																						/>
																					</g>
																				</svg>
																			{:else}
																				<svg
																					class="h-[26px] w-[26px]"
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
																			{/if}
																		</div>
																		<h3 class="text-base font-semibold text-neutral-900">
																			{getThreadSubject(subIssue.id)}
																		</h3>
																	</div>
																{:else if (replyDraftsByIssue[subIssue.id]?.length ?? 0) > 0}
																	<div class="flex items-center gap-2">
																		{#if !(replyDraftsByIssue[subIssue.id] ?? []).some((d) => d.channel === 'appfolio')}
																			<div class="flex items-center justify-center">
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
																		{:else}
																			<h3 class="text-base font-semibold text-neutral-900">
																				Drafted reply
																			</h3>
																		{/if}
																	</div>
																{/if}
																<div class="space-y-3">
																	{#each collectMessagesForIssue(messagesByIssue, subIssue.id) as message}
																		<EmailMessageWithDraft
																			message={{
																				...message,
																				timestampLabel: formatTimestamp(message.timestamp)
																			}}
																			draft={null}
																		/>
																	{/each}
																	{#each replyDraftsByIssue[subIssue.id] ?? [] as draft}
																		{#if draft.channel === 'appfolio'}
																			<AppfolioDraftMessage
																				message={{
																					id: draft.message_id,
																					subject: draft.subject,
																					message: '',
																					sender: 'outbound',
																					direction: 'outbound',
																					timestampLabel: formatTimestamp(draft.updated_at)
																				}}
																				{draft}
																				approvedBy={getAppfolioApprovedBy(draft.issue_id)}
																				{vendors}
																				recommendedVendors={recommendedVendorsByIssueId[
																					draft.issue_id
																				] ?? []}
																				on:sent={(e) => handleDraftSent(e.detail)}
																				on:assigneeUpdated={(e) =>
																					handleAppfolioAssigneeUpdate(e.detail)}
																			/>
																		{:else}
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
																				recommendedVendors={recommendedVendorsByIssueId[
																					draft.issue_id
																				] ?? []}
																				on:sent={(e) => handleDraftSent(e.detail)}
																			/>
																		{/if}
																	{/each}
																</div>
															</div>
														{/if}

														{#if (newDraftsByIssue[subIssue.id]?.length ?? 0) > 0}
															<div class="space-y-3">
																<div class="flex items-center gap-2">
																	{#if !(newDraftsByIssue[subIssue.id] ?? []).some((d) => d.channel === 'appfolio')}
																		<div class="flex items-center justify-center">
																			<svg
																				class="h-[26px] w-[26px]"
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
																			Draft email
																		</h3>
																	{:else}
																		<svg
																			class="h-7 w-7"
																			viewBox="0 0 1024 1024"
																			fill="none"
																			xmlns="http://www.w3.org/2000/svg"
																		>
																			<circle cx="512" cy="512" r="512" fill="#007bc7" />
																			<g
																				transform="translate(512,512) scale(1.25) translate(-512,-512)"
																			>
																				<path
																					d="M582.49 516a77.29 77.29 0 0 0 15.31-4.9v31.72c0 69.9-67.12 85.21-93 85.21-35.29 0-73.3-18.75-73.3-49.15 0-32.73 29.44-43 91.33-52.48 16.08-2.4 42.3-7.06 59.66-10.4zM654.12 480.77c0-10.41-.33-20.26-.33-28.89 0-54.88-26.32-82.32-48.42-95.68a147.66 147.66 0 0 0-73.86-18.53c-54.77 0-95.12 15.42-120.05 45.75a115.6 115.6 0 0 0-24.93 62.78 9.53 9.53 0 0 0 0 1.78 29.28 29.28 0 0 0 29.55 26.55 27.27 27.27 0 0 0 29.72-23c6.35-29.5 20.43-56.83 80.59-56.83 31.89 0 52.71 6.57 63.62 20.09a39 39 0 0 1 10.19 30.28c0 10-3.79 22.26-33.39 28.78-19.2 4.17-39.41 6.51-58.94 8.74l-9.35 1.11c-110.77 13.1-127.47 71.54-127.47 105.16 0 61 73.36 95.51 126.34 97.18h9.8a153.19 153.19 0 0 0 58.66-10.3l1.61-.67a136.14 136.14 0 0 0 79.59-81c8.63-23.25 7.85-71.07 7.07-113.3z"
																					fill="white"
																				/>
																			</g>
																		</svg>
																		<h3 class="text-base font-semibold text-neutral-900">
																			{(newDraftsByIssue[subIssue.id] ?? []).some(
																				(d) => d.recipient_email
																			)
																				? 'Assign Vendor'
																				: 'Drafted reply'}
																		</h3>
																	{/if}
																</div>
																<div class="space-y-3">
																	{#each newDraftsByIssue[subIssue.id] ?? [] as draft}
																		{#if draft.channel === 'appfolio'}
																			<AppfolioDraftMessage
																				message={{
																					id: draft.message_id,
																					subject: draft.subject,
																					message: '',
																					sender: 'outbound',
																					direction: 'outbound',
																					timestampLabel: formatTimestamp(draft.updated_at)
																				}}
																				{draft}
																				approvedBy={getAppfolioApprovedBy(draft.issue_id)}
																				{vendors}
																				recommendedVendors={recommendedVendorsByIssueId[
																					draft.issue_id
																				] ?? []}
																				on:sent={(e) => handleDraftSent(e.detail)}
																				on:assigneeUpdated={(e) =>
																					handleAppfolioAssigneeUpdate(e.detail)}
																			/>
																		{:else}
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
																				recommendedVendors={recommendedVendorsByIssueId[
																					draft.issue_id
																				] ?? []}
																				on:sent={(e) => handleDraftSent(e.detail)}
																			/>
																		{/if}
																	{/each}
																</div>
															</div>
														{/if}
													</div>
												</div>
											</div>
										</div>
									{/if}
								{/each}
							</div>
						{/if}

						<div class="mt-6 border-t border-neutral-100 pt-4 sm:pt-6">
							<div class="flex items-center justify-between">
								<h2 class="text-base font-semibold text-neutral-800">Activity</h2>
								<div class="text-sm text-neutral-400">Unsubscribe</div>
							</div>
							{#if !hasActivity}
								<div class="mt-4 text-sm text-neutral-500">No activity yet.</div>
							{:else}
								<div class="mt-4 space-y-4 text-sm">
									{#if (approvedAppfolioDraftsByIssue[issueId]?.length ?? 0) > 0}
										<div class="space-y-3">
											<div class="flex items-center gap-2">
												<svg
													class="h-7 w-7"
													viewBox="0 0 1024 1024"
													fill="none"
													xmlns="http://www.w3.org/2000/svg"
												>
													<circle cx="512" cy="512" r="512" fill="#007bc7" />
													<g transform="translate(512,512) scale(1.25) translate(-512,-512)">
														<path
															d="M582.49 516a77.29 77.29 0 0 0 15.31-4.9v31.72c0 69.9-67.12 85.21-93 85.21-35.29 0-73.3-18.75-73.3-49.15 0-32.73 29.44-43 91.33-52.48 16.08-2.4 42.3-7.06 59.66-10.4zM654.12 480.77c0-10.41-.33-20.26-.33-28.89 0-54.88-26.32-82.32-48.42-95.68a147.66 147.66 0 0 0-73.86-18.53c-54.77 0-95.12 15.42-120.05 45.75a115.6 115.6 0 0 0-24.93 62.78 9.53 9.53 0 0 0 0 1.78 29.28 29.28 0 0 0 29.55 26.55 27.27 27.27 0 0 0 29.72-23c6.35-29.5 20.43-56.83 80.59-56.83 31.89 0 52.71 6.57 63.62 20.09a39 39 0 0 1 10.19 30.28c0 10-3.79 22.26-33.39 28.78-19.2 4.17-39.41 6.51-58.94 8.74l-9.35 1.11c-110.77 13.1-127.47 71.54-127.47 105.16 0 61 73.36 95.51 126.34 97.18h9.8a153.19 153.19 0 0 0 58.66-10.3l1.61-.67a136.14 136.14 0 0 0 79.59-81c8.63-23.25 7.85-71.07 7.07-113.3z"
															fill="white"
														/>
													</g>
												</svg>
												<h3 class="text-base font-semibold text-neutral-900">Approved message</h3>
											</div>
											<div class="space-y-3">
												{#each approvedAppfolioDraftsByIssue[issueId] ?? [] as entry (entry.log?.id)}
													<AppfolioDraftMessage
														draft={entry.draft}
														approvedBy={entry.log?.data?.approved_by ??
															getActivityActor(entry.log).name}
														{vendors}
														recommendedVendors={recommendedVendorsByIssueId[issueId] ?? []}
														readonly={true}
													/>
												{/each}
											</div>
										</div>
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
																{#if log.type === 'issue_created'}
																	{#if log.data?.from || log.data?.from_email}
																		{formatTenantName(log.data.from) ?? log.data.from_email} created the
																		issue
																	{:else}
																		Issue created
																	{/if}
																{:else if log.type === 'status_change'}
																	{getActivityActor(log).name} changed status to {getStatusLabelFromLog(
																		log
																	)}
																{:else if log.type === 'assignee_change'}
																	{getActivityActor(log).name} assigned issue to {getAssigneeNameFromLog(
																		log
																	)}
																{:else if log.type === 'appfolio_approved'}
																	Approved by {log?.data?.approved_by ?? getActivityActor(log).name}
																{/if}
															</p>
															<span class="shrink-0 text-xs text-neutral-400">
																{#if log.type === 'issue_created'}
																	{new Date(log.created_at).toLocaleDateString('en-US', {
																		month: 'short',
																		day: 'numeric',
																		year: 'numeric',
																		timeZone: 'UTC'
																	})}
																{:else}
																	{formatTimestamp(log.created_at)}
																{/if}
															</span>
														</div>
													</div>
												</div>
											</div>
										{/if}
									{/each}

									{#each subIssues as subIssue}
										{#if (logsByIssue[subIssue.id]?.length ?? 0) > 0}
											<div>
												<button
													type="button"
													class="tooltip-target relative ml-0.5 flex w-full cursor-pointer items-center justify-between text-xs font-medium tracking-wide text-neutral-500 hover:text-neutral-700"
													on:click={() => toggleActivity(subIssue.id)}
												>
													<div
														class="flex items-center gap-2 rounded-md px-0 py-1.5 transition select-none hover:text-neutral-700"
													>
														<svg
															xmlns="http://www.w3.org/2000/svg"
															width="12"
															height="12"
															fill="currentColor"
															class="chevron-icon transition-transform duration-150 ease-in-out"
															class:rotate-[-90deg]={!(activityOpen[subIssue.id] ?? true)}
															viewBox="0 0 16 16"
														>
															<path
																d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
															/>
														</svg>
														<span>{subIssue.name}</span>
													</div>
													<div
														class="delayed-tooltip absolute top-full left-0 z-10 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
													>
														{(activityOpen[subIssue.id] ?? true) ? 'Collapse' : 'Expand'}
													</div>
													<span class="text-neutral-300">
														{logsByIssue[subIssue.id]?.length ?? 0}
													</span>
												</button>
												<div
													class="grid transition-[grid-template-rows] duration-200 ease-in-out"
													style:grid-template-rows={(activityOpen[subIssue.id] ?? true)
														? '1fr'
														: '0fr'}
												>
													<div class="overflow-hidden">
														<div
															class="space-y-3 py-2 transition-opacity duration-200"
															class:opacity-0={!(activityOpen[subIssue.id] ?? true)}
														>
															{#if (approvedAppfolioDraftsByIssue[subIssue.id]?.length ?? 0) > 0}
																<div class="space-y-3">
																	<div class="flex items-center gap-2">
																		<svg
																			class="h-7 w-7"
																			viewBox="0 0 1024 1024"
																			fill="none"
																			xmlns="http://www.w3.org/2000/svg"
																		>
																			<circle cx="512" cy="512" r="512" fill="#007bc7" />
																			<g
																				transform="translate(512,512) scale(1.25) translate(-512,-512)"
																			>
																				<path
																					d="M582.49 516a77.29 77.29 0 0 0 15.31-4.9v31.72c0 69.9-67.12 85.21-93 85.21-35.29 0-73.3-18.75-73.3-49.15 0-32.73 29.44-43 91.33-52.48 16.08-2.4 42.3-7.06 59.66-10.4zM654.12 480.77c0-10.41-.33-20.26-.33-28.89 0-54.88-26.32-82.32-48.42-95.68a147.66 147.66 0 0 0-73.86-18.53c-54.77 0-95.12 15.42-120.05 45.75a115.6 115.6 0 0 0-24.93 62.78 9.53 9.53 0 0 0 0 1.78 29.28 29.28 0 0 0 29.55 26.55 27.27 27.27 0 0 0 29.72-23c6.35-29.5 20.43-56.83 80.59-56.83 31.89 0 52.71 6.57 63.62 20.09a39 39 0 0 1 10.19 30.28c0 10-3.79 22.26-33.39 28.78-19.2 4.17-39.41 6.51-58.94 8.74l-9.35 1.11c-110.77 13.1-127.47 71.54-127.47 105.16 0 61 73.36 95.51 126.34 97.18h9.8a153.19 153.19 0 0 0 58.66-10.3l1.61-.67a136.14 136.14 0 0 0 79.59-81c8.63-23.25 7.85-71.07 7.07-113.3z"
																					fill="white"
																				/>
																			</g>
																		</svg>
																		<h3 class="text-base font-semibold text-neutral-900">
																			Approved message
																		</h3>
																	</div>
																	<div class="space-y-3">
																		{#each approvedAppfolioDraftsByIssue[subIssue.id] ?? [] as entry (entry.log?.id)}
																			<AppfolioDraftMessage
																				draft={entry.draft}
																				approvedBy={entry.log?.data?.approved_by ??
																					getActivityActor(entry.log).name}
																				{vendors}
																				recommendedVendors={recommendedVendorsByIssueId[
																					subIssue.id
																				] ?? []}
																				readonly={true}
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
																						{#if log.type === 'issue_created'}
																							{#if log.data?.from || log.data?.from_email}
																								{formatTenantName(log.data.from) ??
																									log.data.from_email} created the issue
																							{:else}
																								Issue created
																							{/if}
																						{:else if log.type === 'status_change'}
																							{getActivityActor(log).name} changed status to {getStatusLabelFromLog(
																								log
																							)}
																						{:else if log.type === 'assignee_change'}
																							{getActivityActor(log).name} assigned issue to {getAssigneeNameFromLog(
																								log
																							)}
																						{:else if log.type === 'appfolio_approved'}
																							Approved by {log?.data?.approved_by ??
																								getActivityActor(log).name}
																						{/if}
																					</p>
																					<span class="shrink-0 text-xs text-neutral-400">
																						{#if log.type === 'issue_created'}
																							{new Date(log.created_at).toLocaleDateString(
																								'en-US',
																								{
																									month: 'short',
																									day: 'numeric',
																									year: 'numeric',
																									timeZone: 'UTC'
																								}
																							)}
																						{:else}
																							{formatTimestamp(log.created_at)}
																						{/if}
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
						</div>
						<div class="mt-6">
							<div
								class="rounded-xl border border-neutral-100 bg-white px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
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
		</div>

		<aside class="hidden">
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
					<div class="tooltip-target relative">
						<button
							type="button"
							class={`-ml-2 flex w-40 items-center gap-2 rounded-sm p-1 px-2 transition ${
								canEditIssue ? 'hover:bg-stone-100' : 'cursor-default opacity-60'
							}`}
							disabled={!canEditIssue}
							aria-disabled={!canEditIssue}
							on:click|stopPropagation={() => {
								if (!canEditIssue) return;
								propertyOpen = !propertyOpen;
								unitOpen = false;
								statusOpen = false;
								assigneeOpen = false;
								urgentOpen = false;
								urgentHelpOpen = false;
							}}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								fill="currentColor"
								class="text-neutral-400"
								viewBox="0 0 16 16"
							>
								<path
									d="M3 0a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V16h3a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1zm1 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5M4 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM7.5 5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM4.5 8h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5"
								/>
							</svg>
							<span class="truncate text-neutral-700">{propertyName}</span>
						</button>
						<div
							class="delayed-tooltip absolute top-full left-0 z-10 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
						>
							Copy issue link
						</div>
						{#if !rightSidebarMenuOpen}
							<div
								class="delayed-tooltip absolute top-full left-[-0.5rem] z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
							>
								Change property
							</div>
						{/if}
						{#if propertyOpen && canEditIssue}
							<div
								class="absolute right-auto left-[-0.5rem] z-10 mt-2 w-56 origin-top-left rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
								on:click|stopPropagation
							>
								<button
									type="button"
									class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
										!issuePropertyId ? 'bg-neutral-50' : ''
									}`}
									on:click={() => handlePropertySelect(null)}
								>
									<span>No property</span>
									{#if !issuePropertyId}
										<span class="text-xs text-neutral-400">Selected</span>
									{/if}
								</button>
								<div class="my-1 h-px bg-neutral-100"></div>
								{#each properties as property}
									<button
										type="button"
										class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
											issuePropertyId === property.id ? 'bg-neutral-50' : ''
										}`}
										on:click={() => handlePropertySelect(property.id)}
									>
										<span class="truncate">{property.name}</span>
										{#if issuePropertyId === property.id}
											<span class="text-xs text-neutral-400">Selected</span>
										{/if}
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<div class="tooltip-target relative">
						<button
							type="button"
							class={`-ml-2 flex w-40 items-center gap-2 rounded-sm p-1 px-2 transition ${
								canEditIssue ? 'hover:bg-stone-100' : 'cursor-default opacity-60'
							}`}
							disabled={!canEditIssue}
							aria-disabled={!canEditIssue}
							on:click|stopPropagation={() => {
								if (!canEditIssue) return;
								unitOpen = !unitOpen;
								propertyOpen = false;
								statusOpen = false;
								assigneeOpen = false;
								urgentOpen = false;
								urgentHelpOpen = false;
							}}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								fill="currentColor"
								class="text-neutral-400"
								viewBox="0 0 16 16"
							>
								<path
									d="M6.5 14.5v-3.505c0-.245.25-.495.5-.495h2c.25 0 .5.25.5.5v3.5a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.146-.354L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293L8.354 1.146a.5.5 0 0 0-.708 0l-6 6A.5.5 0 0 0 1.5 7.5v7a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5"
								/>
							</svg>
							<span class="truncate text-neutral-700">{unitName}</span>
						</button>
						{#if !rightSidebarMenuOpen}
							<div
								class="delayed-tooltip absolute top-full left-[-0.5rem] z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
							>
								Change unit
							</div>
						{/if}
						{#if unitOpen && canEditIssue}
							<div
								class="absolute right-auto left-[-0.5rem] z-10 mt-2 w-56 origin-top-left rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
								on:click|stopPropagation
							>
								<button
									type="button"
									class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
										!issueUnitId ? 'bg-neutral-50' : ''
									}`}
									on:click={() => handleUnitSelect(null)}
								>
									<span>No unit</span>
									{#if !issueUnitId}
										<span class="text-xs text-neutral-400">Selected</span>
									{/if}
								</button>
								<div class="my-1 h-px bg-neutral-100"></div>
								{#if availableUnits.length}
									{#each availableUnits as unit}
										<button
											type="button"
											class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
												issueUnitId === unit.id ? 'bg-neutral-50' : ''
											}`}
											on:click={() => handleUnitSelect(unit.id)}
										>
											<span class="truncate">{unit.name}</span>
											{#if issueUnitId === unit.id}
												<span class="text-xs text-neutral-400">Selected</span>
											{/if}
										</button>
									{/each}
								{:else}
									<div class="px-3 py-2 text-neutral-400">No units available.</div>
								{/if}
							</div>
						{/if}
					</div>
					<div class="tooltip-target relative">
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
								propertyOpen = false;
								unitOpen = false;
								assigneeOpen = false;
								urgentOpen = false;
								urgentHelpOpen = false;
							}}
						>
							<span class={`h-3.5 w-3.5 rounded-full border-[1.5px] ${statusMeta.statusClass}`}
							></span>
							<span>{statusMeta.label}</span>
						</button>
						{#if !rightSidebarMenuOpen}
							<div
								class="delayed-tooltip absolute top-full left-[-0.5rem] z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
							>
								Change status
							</div>
						{/if}
						{#if statusOpen && canEditIssue}
							<div
								class="absolute right-auto left-[-0.5rem] z-10 mt-2 w-48 origin-top-left rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
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
											class={`h-4 w-4 rounded-full border-[1.5px] ${
												(statusConfig[status] ?? statusConfig.todo).statusClass
											}`}
										></span>
										<span>{(statusConfig[status] ?? statusConfig.todo).label}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<div class="flex w-full items-center gap-2">
						<div class="tooltip-target group relative">
							<div
								class={`-ml-2 flex w-40 items-center gap-2 rounded-sm p-1 px-2 transition ${
									canEditIssue && !isSubissue ? 'hover:bg-stone-100' : 'opacity-60'
								}`}
							>
								<button
									type="button"
									class={`flex min-w-0 flex-1 items-center gap-2 text-left ${
										canEditIssue && !isSubissue ? '' : 'cursor-not-allowed'
									}`}
									disabled={!canEditIssue || isSubissue}
									aria-disabled={!canEditIssue || isSubissue}
									on:click|stopPropagation={() => {
										if (!canEditIssue || isSubissue) return;
										urgentOpen = !urgentOpen;
										urgentHelpOpen = false;
										statusOpen = false;
										assigneeOpen = false;
										propertyOpen = false;
										unitOpen = false;
									}}
								>
									{#if displayUrgent}
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="16"
											height="16"
											fill="currentColor"
											class="text-rose-600"
											viewBox="0 0 16 16"
										>
											<path
												d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm6 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
											/>
										</svg>
										<span>Urgent</span>
									{:else}
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="16"
											height="16"
											fill="currentColor"
											class="text-neutral-400"
											viewBox="0 0 16 16"
										>
											<path
												d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm2.5 7.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1"
											/>
										</svg>
										<span>Not urgent</span>
									{/if}
								</button>
								<div class="relative ml-auto">
									<button
										type="button"
										class="inline-flex h-5 w-5 items-center justify-center rounded-full text-neutral-400 transition hover:text-neutral-600"
										aria-label="Urgent issue help"
										aria-expanded={urgentHelpOpen}
										on:click|stopPropagation={() => {
											urgentOpen = false;
											urgentHelpOpen = !urgentHelpOpen;
											propertyOpen = false;
											unitOpen = false;
											statusOpen = false;
											assigneeOpen = false;
										}}
										on:blur={() => (urgentHelpOpen = false)}
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="16"
											height="16"
											fill="currentColor"
											class="bi bi-question-circle"
											viewBox="0 0 16 16"
										>
											<path
												d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"
											/>
											<path
												d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286m1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94"
											/>
										</svg>
									</button>
									{#if urgentHelpOpen}
										<div
											class="absolute top-full right-0 z-30 mt-2 min-w-[260px] rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs leading-snug text-neutral-700 shadow-sm"
										>
											Bedrock immediately assigns a vendor for urgent issues.
										</div>
									{/if}
								</div>
							</div>
							{#if !rightSidebarMenuOpen}
								<div
									class="delayed-tooltip absolute top-full left-[-0.5rem] z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
								>
									{isSubissue ? 'Change urgency in the root issue' : 'Change urgency'}
								</div>
							{/if}
							{#if urgentOpen && canEditIssue && !isSubissue}
								<div
									class="absolute right-auto left-[-0.5rem] z-10 mt-2 w-48 origin-top-left rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
									on:click|stopPropagation
								>
									<button
										type="button"
										class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
											displayUrgent ? 'bg-neutral-50' : ''
										}`}
										on:click={() => handleUrgentChange(true)}
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="16"
											height="16"
											fill="currentColor"
											class="text-rose-600"
											viewBox="0 0 16 16"
										>
											<path
												d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm6 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
											/>
										</svg>
										<span>Urgent</span>
									</button>
									<button
										type="button"
										class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
											!displayUrgent ? 'bg-neutral-50' : ''
										}`}
										on:click={() => handleUrgentChange(false)}
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="16"
											height="16"
											fill="currentColor"
											class="text-neutral-400"
											viewBox="0 0 16 16"
										>
											<path
												d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm2.5 7.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1"
											/>
										</svg>
										<span>Not urgent</span>
									</button>
								</div>
							{/if}
						</div>
					</div>
					<div class="tooltip-target relative">
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
								propertyOpen = false;
								unitOpen = false;
								statusOpen = false;
								urgentOpen = false;
								urgentHelpOpen = false;
							}}
						>
							{#if assignee}
								<div
									class={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${getAssigneeAvatar(assignee).color}`}
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
						{#if !rightSidebarMenuOpen}
							<div
								class="delayed-tooltip absolute top-full left-[-0.5rem] z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
							>
								Change assignee
							</div>
						{/if}
						{#if assigneeOpen && canEditIssue}
							<div
								class="absolute right-auto left-[-0.5rem] z-10 mt-2 w-56 origin-top-left rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
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
												class={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${getMemberAvatar(member).color}`}
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
	{#if showUrgencyPolicyPrompt}
		<div class="fixed inset-0 z-40 bg-neutral-900/30" on:click={closeUrgencyPolicyPrompt}></div>
		<div class="fixed inset-0 z-50 flex items-center justify-center px-4">
			<div
				class="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl"
				role="dialog"
				aria-modal="true"
				aria-labelledby="urgency-policy-title"
				on:click|stopPropagation
			>
				<div class="flex items-start justify-between gap-4">
					<div>
						<div id="urgency-policy-title" class="text-lg font-medium text-neutral-800">
							Update urgency policy?
						</div>
						<p class="mt-1 text-xs text-neutral-500">
							Apply this urgency setting to future issues like this.
						</p>
					</div>
					<button
						class="text-neutral-400 transition hover:text-neutral-600"
						on:click={closeUrgencyPolicyPrompt}
						aria-label="Close"
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-5 w-5">
							<path
								fill="currentColor"
								d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12l-4.9 4.89a1 1 0 1 0 1.41 1.42L12 13.41l4.89 4.9a1 1 0 0 0 1.42-1.41L13.41 12l4.9-4.89a1 1 0 0 0-.01-1.4z"
							/>
						</svg>
					</button>
				</div>
				<div class="mt-4 space-y-3">
					<div>
						<label class="text-xs text-neutral-500">Maintenance issue</label>
						<input
							class="mt-1 w-full rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							bind:value={urgencyPolicyIssue}
							required
							type="text"
						/>
					</div>
					<div>
						<label class="text-xs text-neutral-500">Urgency</label>
						<select
							class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							bind:value={urgencyPolicyValue}
						>
							<option value="urgent">Urgent</option>
							<option value="not_urgent">Not urgent</option>
						</select>
					</div>
					{#if urgencyPolicyError}
						<p class="text-xs text-rose-600">{urgencyPolicyError}</p>
					{/if}
				</div>
				<div class="mt-6 flex items-center justify-end gap-3">
					<button
						type="button"
						class="rounded-full border border-neutral-200 px-4 py-2 text-sm text-neutral-600 transition hover:border-neutral-300"
						on:click={closeUrgencyPolicyPrompt}
						disabled={urgencyPolicyLoading}
					>
						No thanks
					</button>
					<button
						type="button"
						class="rounded-full bg-neutral-900 px-4 py-2 text-sm text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
						on:click={saveUrgencyPolicy}
						disabled={urgencyPolicyLoading}
					>
						{#if urgencyPolicyLoading}
							Saving...
						{:else}
							{urgencyPolicyMatchingId ? 'Update policy' : 'Create policy'}
						{/if}
					</button>
				</div>
			</div>
		</div>
	{/if}
{:else}
	<div class="flex h-full flex-col">
		<div class="border-b border-neutral-200 px-6 py-2">
			<div class="skeleton h-4 w-32 rounded"></div>
		</div>
		<div class="flex-1 px-10 pt-8">
			<div class="skeleton h-7 w-2/3 rounded"></div>
			<div class="skeleton mt-3 h-4 w-1/2 rounded"></div>
			<div class="mt-8 space-y-3">
				{#each { length: 3 } as _}
					<div class="skeleton h-4 w-full rounded"></div>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.tooltip-target .delayed-tooltip {
		opacity: 0;
		transform: translateY(-4px);
		transition:
			opacity 150ms ease,
			transform 150ms ease;
		transition-delay: 0s;
		pointer-events: none;
	}

	.tooltip-target:hover .delayed-tooltip {
		opacity: 1;
		transform: translateY(0);
		transition-delay: 0s;
	}

	.tooltip-target:focus-within .delayed-tooltip {
		opacity: 0;
		transform: translateY(-4px);
		transition-delay: 0s;
	}

	.tooltip-target:focus-within:hover .delayed-tooltip {
		opacity: 1;
		transform: translateY(0);
		transition-delay: 0s;
	}

	@media (hover: none) {
		.tooltip-target .delayed-tooltip {
			display: none;
		}
	}

	.subissue-hover-tooltip {
		opacity: 1;
		transform: translateY(0);
		transition:
			opacity 120ms ease,
			transform 120ms ease;
		pointer-events: none;
	}
</style>
