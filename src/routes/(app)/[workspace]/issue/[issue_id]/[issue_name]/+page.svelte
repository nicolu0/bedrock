<script>
	// @ts-nocheck
	import { browser } from '$app/environment';
	import { goto, preloadData } from '$app/navigation';
	import { page } from '$app/stores';
	import { get } from 'svelte/store';
	import { onDestroy } from 'svelte';

	import EmailMessageWithDraft from '$lib/components/EmailMessageWithDraft.svelte';
	import { pageReady } from '$lib/stores/pageReady';
	import { peopleCache, ensurePeopleCache } from '$lib/stores/peopleCache.js';
	import {
		getIssueDetail,
		primeIssueDetail,
		updateIssueStatusInDetailCache
	} from '$lib/stores/issueDetailCache.js';
	import { issuesCache, updateIssueStatusInListCache } from '$lib/stores/issuesCache.js';
	import { peopleMembersCache } from '$lib/stores/peopleMembersCache.js';
	import {
		activityCache,
		ensureActivityCache,
		applyMessageDelta,
		applyDraftDelta,
		removeMessageFromCache,
		removeDraftFromCache
	} from '$lib/stores/activityCache.js';
	import {
		activityLogsCache,
		ensureActivityLogsCache,
		applyActivityLogDelta
	} from '$lib/stores/activityLogsCache.js';
	import { supabase } from '$lib/supabaseClient.js';

	export let data;

	if (!browser) {
		pageReady.set(false);
	}

	$: vendors =
		$peopleCache.workspace === workspaceSlug && $peopleCache.data != null
			? $peopleCache.data.filter((person) => person?.role === 'vendor')
			: [];

	$: if (browser && workspaceSlug) {
		ensurePeopleCache(workspaceSlug);
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

	const groupByIssue = (items = []) => {
		const grouped = items.reduce((acc, item) => {
			const key = item?.issue_id;
			if (!key) return acc;
			if (!acc[key]) acc[key] = [];
			acc[key].push(item);
			return acc;
		}, {});
		for (const key of Object.keys(grouped)) {
			grouped[key].sort((a, b) => {
				const timeA = new Date(a?.timestamp ?? a?.created_at ?? 0).getTime();
				const timeB = new Date(b?.timestamp ?? b?.created_at ?? 0).getTime();
				return timeA - timeB;
			});
		}
		return grouped;
	};

	const indexDraftsByMessageId = (items = []) =>
		items.reduce((acc, draft) => {
			const key = draft?.message_id ?? draft?.id;
			if (!key) return acc;
			acc[key] = draft;
			return acc;
		}, {});

	const buildDraftIssueIds = (items = []) =>
		Array.from(new Set(items.map((draft) => draft?.issue_id).filter(Boolean)));

	const findIssueInSections = (sections = [], readableId) => {
		if (!readableId) return null;
		const statusBySection = {
			'in-progress': 'in_progress',
			todo: 'todo',
			done: 'done'
		};
		for (const section of sections) {
			const status = statusBySection[section?.id] ?? 'todo';
			for (const item of section.items ?? []) {
				if (item.readableId === readableId) {
					return {
						id: item.issueId ?? item.id,
						title: item.title,
						name: item.title,
						status,
						property: item.property,
						unit: item.unit,
						issueNumber: item.issueNumber,
						readableId: item.readableId
					};
				}
				for (const sub of item.subIssues ?? []) {
					if (sub.readableId === readableId) {
						return {
							id: sub.issueId ?? sub.id,
							title: sub.title,
							name: sub.title,
							status,
							property: sub.property,
							unit: sub.unit,
							issueNumber: sub.issueNumber,
							readableId: sub.readableId
						};
					}
				}
			}
		}
		return null;
	};

	$: issueKey = $page.params.issue_id ?? '';
	$: issueId =
		listItem?.id ??
		$issuesCache.data?.issues?.find((item) => item.readableId === issueKey)?.id ??
		null;
	$: issueNameSlug = $page.params.issue_name ?? '';
	$: workspaceSlug = $page.params.workspace;

	// Cache / seed data
	$: cached = browser && issueId ? getIssueDetail(issueId) : null;

	// Seed partial data from the flat issues list (includes sub-issues)
	$: listItem =
		browser && issueKey
			? ($issuesCache.data?.issues?.find((item) => item.readableId === issueKey) ??
				findIssueInSections($issuesCache.data?.sections ?? [], issueKey) ??
				null)
			: null;

	// Derive sub-issues (including descendants) from flat issues list as fallback for cold start
	$: listSubIssues =
		browser && issueId
			? (() => {
					const issues = $issuesCache.data?.issues ?? [];
					const childrenByParent = new Map();
					for (const item of issues) {
						if (!item.parent_id) continue;
						if (!childrenByParent.has(item.parent_id)) {
							childrenByParent.set(item.parent_id, []);
						}
						childrenByParent.get(item.parent_id).push(item);
					}
					const collect = (parentId) => {
						const children = childrenByParent.get(parentId) ?? [];
						return children.flatMap((child) => {
							const entry = {
								id: child.id,
								name: child.name ?? child.title,
								status: child.status,
								parent_id: parentId,
								property: child.property ?? null,
								unit: child.unit ?? null,
								issueNumber: child.issueNumber ?? null,
								readableId: child.readableId ?? null
							};
							return [entry, ...collect(child.id)];
						});
					};
					return sortSubIssues(collect(issueId));
				})()
			: [];

	// Seed assignee from members cache using the current user's ID (from layout data)
	$: memberEntry =
		browser && data?.userId
			? (get(peopleMembersCache)?.data?.find((m) => m.user_id === data.userId) ?? null)
			: null;

	$: seedAssignee = memberEntry ? { id: data.userId, name: memberEntry.users?.name } : null;

	let issue = null;
	let subIssues = [];
	let assignee = null;
	let messagesByIssue = {};
	let emailDraftsByMessageId = {};
	let draftIssueIds = [];
	let logsByIssue = {};
	let _resolvedReadableIdKey = null;

	// Reset local state when route/issue changes, preferring cache -> list seed
	let _seededForIssueId = null;
	$: if (issueId && issueId !== _seededForIssueId) {
		_seededForIssueId = issueId;
		if (browser && !listItem) pageReady.set(false);
		issue = null;
		subIssues = [];
		assignee = seedAssignee;
		issue =
			cached?.issue ??
			(listItem
				? {
						id: listItem.id ?? issueId,
						name: listItem.title ?? listItem.name,
						status: listItem.status,
						description: null,
						property: listItem.property ?? null,
						unit: listItem.unit ?? null,
						issueNumber: listItem.issueNumber ?? null,
						readableId: listItem.readableId ?? null
					}
				: null);

		subIssues = sortSubIssues(cached?.subIssues ?? listSubIssues);
		assignee = cached?.assignee ?? seedAssignee;
		messagesByIssue = $activityCache.data?.messagesByIssue ?? {};
		emailDraftsByMessageId = $activityCache.data?.emailDraftsByMessageId ?? {};
		draftIssueIds = $activityCache.data?.draftIssueIds ?? [];
		logsByIssue = $activityLogsCache.data?.logsByIssue ?? {};
		if (!issue) pageReady.set(false);
	}

	// Fill in blank issue when issuesCache loads after cold start
	$: if (browser && _seededForIssueId === issueId && !issue && listItem) {
		issue = {
			id: listItem.id ?? issueId,
			name: listItem.title ?? listItem.name,
			status: listItem.status,
			description: null,
			property: listItem.property ?? null,
			unit: listItem.unit ?? null,
			issueNumber: listItem.issueNumber ?? null,
			readableId: listItem.readableId ?? null
		};
	}

	$: if (browser && issueKey && !issueId && _resolvedReadableIdKey !== issueKey) {
		_resolvedReadableIdKey = issueKey;
		pageReady.set(false);
		supabase
			.from('issues')
			.select('id, name, status, issue_number, readable_id, unit_id, units(name, properties(name))')
			.eq('readable_id', issueKey)
			.maybeSingle()
			.then(({ data: resolved, error: resolveErr }) => {
				if (resolveErr) {
					console.error('[issue] resolve readable_id error:', resolveErr);
					return;
				}
				if (resolved?.id) {
					issueId = resolved.id;
					issue = {
						id: resolved.id,
						name: resolved.name,
						status: resolved.status,
						description: null,
						property: resolved.units?.properties?.name ?? null,
						unit: resolved.units?.name ?? null,
						issueNumber: resolved.issue_number ?? null,
						readableId: resolved.readable_id ?? null
					};
					pageReady.set(true);
				}
			});
	}

	$: if (browser && issueId && !issue && !listItem) {
		pageReady.set(false);
	}

	let _fadeIssueId = null;
	$: subIssuesReady = Boolean(subIssues.length);
	$: activityReady =
		$activityCache.workspace === workspaceSlug &&
		!$activityCache.loading &&
		$activityLogsCache.workspace === workspaceSlug &&
		!$activityLogsCache.loading;
	$: if (browser && issue && _fadeIssueId !== issueId) {
		_fadeIssueId = issueId;
		const shouldAnimate = !listItem;
		if (shouldAnimate && subIssuesReady && activityReady) {
			pageReady.set(false);
			setTimeout(() => pageReady.set(true), 50);
		} else if (!shouldAnimate) {
			pageReady.set(true);
		}
	}

	// Sync subIssues from issuesCache on cold start or when cache grows (e.g. new subissue created)
	$: if (browser && _seededForIssueId === issueId && listSubIssues.length > subIssues.length) {
		subIssues = sortSubIssues(listSubIssues);
	}

	let _forcedActivityIssueId = null;

	$: if (browser && issueId) {
		const nextMessagesByIssue = $activityCache.data?.messagesByIssue ?? {};
		const nextDraftsByMessage = $activityCache.data?.emailDraftsByMessageId ?? {};
		const nextDraftIssueIds = $activityCache.data?.draftIssueIds ?? [];
		const nextLogsByIssue = $activityLogsCache.data?.logsByIssue ?? {};
		if (Object.keys(nextMessagesByIssue).length) messagesByIssue = nextMessagesByIssue;
		if (Object.keys(nextDraftsByMessage).length) emailDraftsByMessageId = nextDraftsByMessage;
		if (nextDraftIssueIds.length) draftIssueIds = nextDraftIssueIds;
		if (Object.keys(nextLogsByIssue).length) logsByIssue = nextLogsByIssue;
	}

	$: if (browser && workspaceSlug && issueId && issueId !== _forcedActivityIssueId) {
		_forcedActivityIssueId = issueId;
		ensureActivityCache(workspaceSlug, { force: true });
	}

	let _forcedLogsIssueId = null;
	$: if (browser && workspaceSlug && issueId && issueId !== _forcedLogsIssueId) {
		_forcedLogsIssueId = issueId;
		ensureActivityLogsCache(workspaceSlug, { force: true });
	}

	let _loadedSubIssuesForId = null;
	$: if (browser && issueId && issueId !== _loadedSubIssuesForId) {
		_loadedSubIssuesForId = issueId;
		supabase
			.from('issues')
			.select(
				'id, name, status, parent_id, issue_number, readable_id, units(name, properties(name))'
			)
			.eq('parent_id', issueId)
			.then(({ data: freshSubIssues, error: subErr }) => {
				if (subErr) {
					console.error('[subIssues] fetch error:', subErr);
					return;
				}
				if (freshSubIssues?.length && _seededForIssueId === issueId) {
					subIssues = sortSubIssues(
						freshSubIssues.map((s) => ({
							id: s.id,
							name: s.name,
							status: s.status,
							parent_id: issueId,
							property: s.units?.properties?.name ?? null,
							unit: s.units?.name ?? null,
							issueNumber: s.issue_number ?? null,
							readableId: s.readable_id ?? null
						}))
					);
					const current = getIssueDetail(issueId);
					if (current) {
						primeIssueDetail(issueId, { ...current, subIssues });
					}
				}
			});
	}

	$: issueName = issue?.name ?? '';

	$: issueDescription = issue?.description ?? '';
	$: statusKey = issue?.status ?? 'todo';
	$: statusMeta = statusConfig[statusKey] ?? statusConfig.todo;
	$: assigneeName = assignee?.name ?? 'Unassigned';
	$: issueReadableId = issue?.readableId ?? listItem?.readableId ?? issueKey;
	$: subIssueProgress = `${subIssues.filter((item) => item.status === 'done').length}/${subIssues.length}`;

	$: draftsByIssue = Object.values(emailDraftsByMessageId ?? {}).reduce((acc, draft) => {
		if (!draft?.issue_id) return acc;
		if (!acc[draft.issue_id]) acc[draft.issue_id] = [];
		acc[draft.issue_id].push(draft);
		return acc;
	}, {});

	const collectMessagesForIssue = (issueId) => {
		const messages = messagesByIssue[issueId] ?? [];
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

	const slugify = (value) =>
		(value ?? '')
			.toString()
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');

	const statusCycle = ['in_progress', 'todo', 'done'];

	const handleStatusChange = async (newStatus) => {
		const prevStatus = statusKey;
		updateIssueStatusInDetailCache(issueId, newStatus);
		updateIssueStatusInListCache(issueId, newStatus);
		issue = { ...issue, status: newStatus };

		const { error } = await supabase.from('issues').update({ status: newStatus }).eq('id', issueId);

		if (error) {
			updateIssueStatusInDetailCache(issueId, prevStatus);
			updateIssueStatusInListCache(issueId, prevStatus);
			issue = { ...issue, status: prevStatus };
		}
	};

	const buildIssueRows = (sections = []) =>
		sections.flatMap((section) =>
			(section.items ?? []).flatMap((item) => {
				const subRows = (item.subIssues ?? []).map((subIssue) => ({
					...subIssue,
					issueId: subIssue.issueId ?? item.issueId,
					parentTitle: subIssue.parentTitle ?? item.title,
					assignees: subIssue.assignees ?? item.assignees ?? 0,
					property: subIssue.property ?? item.property,
					unit: subIssue.unit ?? item.unit,
					isSubIssue: true
				}));
				return [{ ...item, isSubIssue: false }, ...subRows];
			})
		);

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

	$: issueSections = $issuesCache.data?.sections ?? [];
	$: issueRows = buildIssueRows(issueSections);
	$: currentIndex = issueRows.findIndex((item) => item.issueId === issueId);
	$: totalIssues = issueRows.length;
	$: prevIssue = currentIndex > 0 ? issueRows[currentIndex - 1] : null;
	$: nextIssue =
		currentIndex >= 0 && currentIndex < totalIssues - 1 ? issueRows[currentIndex + 1] : null;

	const upsertMessage = applyMessageDelta;
	const removeMessage = removeMessageFromCache;
	const upsertDraft = applyDraftDelta;
	const removeDraft = removeDraftFromCache;

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
						parent_id: issueId,
						issueNumber: newSub.issue_number ?? null,
						readableId: newSub.readable_id ?? null
					};
					if (!subIssues.some((s) => s.id === sub.id)) {
						subIssues = sortSubIssues([...subIssues, sub]);
						const current = getIssueDetail(issueId);
						if (current) primeIssueDetail(issueId, { ...current, subIssues });

						// Catch-up: fetch any messages/drafts written before the per-issue channel subscribes
						const [{ data: msgs }, { data: drafts }] = await Promise.all([
							supabase
								.from('messages')
								.select('id, issue_id, message, sender, subject, timestamp, direction, channel')
								.eq('issue_id', newSub.id),
							supabase
								.from('email_drafts')
								.select('id, issue_id, message_id, sender, recipient, subject, body, updated_at')
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
</script>

<svelte:window on:keydown={onKeydown} />

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
				class="flex-1 overflow-y-auto px-10 py-8 transition-opacity duration-200"
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
									{#each subIssues as subIssue}
										<a
											href={getSubIssueHref(subIssue)}
											class="flex items-center justify-between px-3 py-3 text-sm transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-200 focus-visible:outline-none"
										>
											<div class="flex items-center gap-3">
												<span class="h-4 w-4 rounded-full border border-neutral-300"></span>
												<span class="text-neutral-800">{subIssue.name}</span>
											</div>
											<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
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
					{#if !hasActivity}
						<div class="mt-4 text-sm text-neutral-500">No activity yet.</div>
					{:else}
						<div class="mt-4 space-y-4 text-sm">
							{#if (messagesByIssue[issueId]?.length ?? 0) > 0 || (draftsByIssue[issueId] ?? []).some((d) => !(messagesByIssue[issueId] ?? []).some((m) => m.id === d.message_id))}
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
										{#each draftsByIssue[issueId] ?? [] as draft}
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

							{#each (logsByIssue[issueId] ?? []).filter((l) => l.type !== 'email_inbound' && l.type !== 'email_outbound') as log}
								<div class="flex items-start gap-3 py-2 text-xs text-neutral-500">
									<span class="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-300"></span>
									<div>
										{#if log.type === 'status_change'}
											Status changed · {formatTimestamp(log.created_at)}
										{:else if log.type === 'assignee_change'}
											Assignee changed · {formatTimestamp(log.created_at)}
										{:else if log.type === 'comment'}
											<p class="text-neutral-700">{log.body}</p>
											<span>{formatTimestamp(log.created_at)}</span>
										{/if}
									</div>
								</div>
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
														{#each draftsByIssue[subIssue.id] ?? [] as draft}
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

													{#each (logsByIssue[subIssue.id] ?? []).filter((l) => l.type !== 'email_inbound' && l.type !== 'email_outbound') as log}
														<div class="flex items-start gap-3 py-2 text-xs text-neutral-500">
															<span class="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-300"
															></span>
															<div>
																{#if log.type === 'status_change'}
																	Status changed · {formatTimestamp(log.created_at)}
																{:else if log.type === 'assignee_change'}
																	Assignee changed · {formatTimestamp(log.created_at)}
																{:else if log.type === 'comment'}
																	<p class="text-neutral-700">{log.body}</p>
																	<span>{formatTimestamp(log.created_at)}</span>
																{/if}
															</div>
														</div>
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
			</div>
		</div>

		<aside class="flex w-1/5 border-l border-neutral-200">
			<div
				class="flex w-full flex-col px-6 py-2 transition-opacity duration-150"
				class:opacity-0={!$pageReady}
			>
				<div class="space-y-4 text-sm text-neutral-600">
					<div class="flex items-center gap-2 pb-2">
						<span class="text-neutral-400">{issueReadableId ?? issueKey}</span>
					</div>
					<div class="flex items-center gap-2">
						<div class="h-3.5 w-3.5 rounded-full bg-neutral-200"></div>
						<span>{assigneeName}</span>
					</div>
					<button
						type="button"
						class="flex items-center gap-2 transition hover:opacity-75"
						on:click={() => {
							const idx = statusCycle.indexOf(statusKey);
							handleStatusChange(statusCycle[(idx + 1) % statusCycle.length]);
						}}
					>
						<span class={`h-3.5 w-3.5 rounded-full border ${statusMeta.statusClass}`}></span>
						<span>{statusMeta.label}</span>
					</button>
				</div>
			</div>
		</aside>
	</div>
{:else}
	<div class="h-full w-full bg-white"></div>
{/if}
