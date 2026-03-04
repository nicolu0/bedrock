<script>
	// @ts-nocheck
	import { browser } from '$app/environment';
	import { goto, preloadData } from '$app/navigation';
	import { page } from '$app/stores';
	import { get } from 'svelte/store';
	import { onDestroy } from 'svelte';

	import EmailMessageWithDraft from '$lib/components/EmailMessageWithDraft.svelte';
	import { pageReady } from '$lib/stores/pageReady';
	import { getIssueDetail, primeIssueDetail, updateIssueStatusInDetailCache } from '$lib/stores/issueDetailCache.js';
	import { issuesCache, updateIssueStatusInListCache } from '$lib/stores/issuesCache.js';
	import { membersCache } from '$lib/stores/membersCache.js';
	import { activityCache, ensureActivityCache, applyMessageDelta, applyDraftDelta, removeMessageFromCache, removeDraftFromCache } from '$lib/stores/activityCache.js';
	import { activityLogsCache, ensureActivityLogsCache, applyActivityLogDelta } from '$lib/stores/activityLogsCache.js';
	import { supabase } from '$lib/supabaseClient.js';

	export let data;

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

	$: issueId = $page.params.issue_id ?? data?.issue?.id ?? 'HUB-1';
	$: issueNameSlug = $page.params.issue_name ?? '';
	$: workspaceSlug = $page.params.workspace;

	// Cache / seed data
	$: cached = browser && issueId ? getIssueDetail(issueId) : null;

	// Seed partial data from the flat issues list (includes sub-issues)
	$: listItem =
		browser && issueId
			? ($issuesCache.data?.issues?.find((item) => item.id === issueId) ?? null)
			: null;

	// Derive sub-issues from flat issues list as fallback for cold start
	$: listSubIssues =
		browser && issueId
			? ($issuesCache.data?.issues
					?.filter((item) => item.parent_id === issueId)
					?.map((s) => ({ id: s.id, name: s.name ?? s.title, status: s.status, parent_id: issueId })) ??
				[])
			: [];

	// Seed assignee from members cache using the current user's ID (from layout data)
	$: memberEntry =
		browser && data?.userId
			? (get(membersCache)?.data?.find((m) => m.user_id === data.userId) ?? null)
			: null;

	$: seedAssignee = memberEntry ? { id: data.userId, name: memberEntry.users?.name } : null;

	let issue = null;
	let subIssues = [];
	let assignee = null;
	let messagesByIssue = {};
	let emailDraftsByMessageId = {};
	let draftIssueIds = [];
	let logsByIssue = {};

	// Reset local state when route/issue changes, preferring cache -> list seed
	let _seededForIssueId = null;
	$: if (issueId && issueId !== _seededForIssueId) {
		_seededForIssueId = issueId;
		issue = null;
		subIssues = [];
		assignee = seedAssignee;
		issue =
			cached?.issue ??
			(listItem
				? {
						id: issueId,
						name: listItem.title ?? listItem.name,
						status: listItem.status,
						description: null
					}
				: null);

		subIssues = cached?.subIssues ?? listSubIssues;
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
			id: issueId,
			name: listItem.title ?? listItem.name,
			status: listItem.status,
			description: null
		};
		pageReady.set(true);
	}

	// Sync subIssues from issuesCache on cold start or when cache grows (e.g. new subissue created)
	$: if (browser && _seededForIssueId === issueId && listSubIssues.length > subIssues.length) {
		subIssues = listSubIssues;
	}

	let _forcedActivityIssueId = null;

	$: if (browser && issueId) {
		messagesByIssue = $activityCache.data?.messagesByIssue ?? {};
		emailDraftsByMessageId = $activityCache.data?.emailDraftsByMessageId ?? {};
		draftIssueIds = $activityCache.data?.draftIssueIds ?? [];
		logsByIssue = $activityLogsCache.data?.logsByIssue ?? {};
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
			.select('id, name, status, parent_id')
			.eq('parent_id', issueId)
			.then(({ data: freshSubIssues, error: subErr }) => {
				if (subErr) {
					console.error('[subIssues] fetch error:', subErr);
					return;
				}
				if (freshSubIssues?.length && _seededForIssueId === issueId) {
					subIssues = freshSubIssues.map((s) => ({
						id: s.id,
						name: s.name,
						status: s.status,
						parent_id: issueId
					}));
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

	const getIssueHref = (issueIdValue, title) => {
		const slug = slugify(title);
		return `/${$page.params.workspace}/issue/${issueIdValue}/${slug}`;
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
			.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'issues',
					filter: `parent_id=eq.${issueId}` },
				async ({ new: newSub }) => {
					const sub = { id: newSub.id, name: newSub.name, status: newSub.status, parent_id: issueId };
					if (!subIssues.some((s) => s.id === sub.id)) {
						subIssues = [...subIssues, sub];
						const current = getIssueDetail(issueId);
						if (current) primeIssueDetail(issueId, { ...current, subIssues });

						// Catch-up: fetch any messages/drafts written before the per-issue channel subscribes
						const [{ data: msgs }, { data: drafts }] = await Promise.all([
							supabase.from('messages')
								.select('id, issue_id, message, sender, subject, timestamp, direction, channel')
								.eq('issue_id', newSub.id),
							supabase.from('email_drafts')
								.select('id, issue_id, message_id, sender, recipient, subject, body, updated_at')
								.eq('issue_id', newSub.id)
						]);
						for (const msg of msgs ?? []) applyMessageDelta(msg);
						for (const draft of drafts ?? []) applyDraftDelta(draft);

						const { data: logs } = await supabase
							.from('activity_logs')
							.select('id, issue_id, type, from_email, to_emails, subject, body, data, created_by, created_at')
							.eq('issue_id', newSub.id);
						for (const log of logs ?? []) applyActivityLogDelta(log);
					}
				})
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

<div class="flex h-full">
	<div class="flex min-w-0 flex-1 flex-col">
		<div class="flex items-center justify-between border-b border-neutral-200 px-6 py-2 text-sm text-neutral-600">
			<div
				class="flex items-center gap-2 transition-opacity duration-150"
				class:opacity-0={!$pageReady}
			>
				<a href={backHref} class="text-neutral-700 hover:underline">{backLabel}</a>
				<span class="text-neutral-300">›</span>
				<span class="h-3 w-3 rounded-full border border-amber-500"></span>
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
					href={nextIssue ? getIssueHref(nextIssue.issueId, nextIssue.title) : undefined}
					class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100"
					class:pointer-events-none={!nextIssue}
					class:opacity-40={!nextIssue}
					aria-disabled={!nextIssue}
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
					href={prevIssue ? getIssueHref(prevIssue.issueId, prevIssue.title) : undefined}
					class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100"
					class:pointer-events-none={!prevIssue}
					class:opacity-40={!prevIssue}
					aria-disabled={!prevIssue}
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

		<div class="flex-1 px-10 py-8 transition-opacity duration-150" class:opacity-0={!$pageReady}>
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
					<div class="flex items-center justify-between text-sm text-neutral-600">
						<div class="flex items-center gap-2">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								fill="currentColor"
								class="text-neutral-400"
								viewBox="0 0 16 16"
							>
								<path
									d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
								/>
							</svg>
							<span class="text-neutral-700">Sub-issues</span>
							<span class="text-neutral-400">{subIssueProgress}</span>
						</div>
						<div class="flex items-center gap-2 text-neutral-400"></div>
					</div>
					<div class="mt-3 divide-y divide-neutral-200">
						{#each subIssues as subIssue}
							<a
								href={`/${$page.params.workspace}/issue/${subIssue.id}/${slugify(subIssue.name)}?fromIssueId=${issueId}&fromIssueSlug=${issueNameSlug}&fromIssueTitle=${encodeURIComponent(issueName)}`}
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
						{#if messagesByIssue[issueId]?.length ?? 0}
							<div class="space-y-3">
								{#each collectMessagesForIssue(issueId) as message}
									{#if !emailDraftsByMessageId[message.id] || emailDraftsByMessageId[message.id]?.issue_id === issueId}
										<EmailMessageWithDraft
											message={{
												...message,
												timestampLabel: formatTimestamp(message.timestamp)
											}}
											draft={emailDraftsByMessageId[message.id] ?? null}
										/>
									{/if}
								{/each}
							</div>
						{/if}

						{#if draftsByIssue[issueId]?.length}
							{#each draftsByIssue[issueId].filter((draft) => !(messagesByIssue[issueId] ?? []).some((message) => message.id === draft.message_id)) as draft}
								<EmailMessageWithDraft
									message={{
										id: draft.message_id,
										subject: draft.subject,
										message: '',
										direction: 'outbound',
										timestampLabel: formatTimestamp(draft.updated_at)
									}}
									{draft}
								/>
							{/each}
						{/if}

						{#each (logsByIssue[issueId] ?? []).filter(l => l.type !== 'email_inbound' && l.type !== 'email_outbound') as log}
							<div class="flex items-start gap-3 py-2 text-xs text-neutral-500">
								<span class="mt-0.5 h-1.5 w-1.5 rounded-full bg-neutral-300 shrink-0"></span>
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
								<details class="group" open>
									<summary
										class="flex cursor-pointer items-center justify-between text-xs font-medium tracking-wide text-neutral-500"
									>
										<div
											class="flex items-center gap-2 rounded-md px-3 py-1.5 transition select-none hover:bg-neutral-100"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="12"
												height="12"
												fill="currentColor"
												class="rotate-[-90deg] transition-transform duration-200 ease-out group-open:rotate-0"
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
									</summary>
									<div class="space-y-3 py-2">
										{#each collectMessagesForIssue(subIssue.id) as message}
											{#if !emailDraftsByMessageId[message.id] || emailDraftsByMessageId[message.id]?.issue_id === subIssue.id}
												<EmailMessageWithDraft
													message={{
														...message,
														timestampLabel: formatTimestamp(message.timestamp)
													}}
													draft={emailDraftsByMessageId[message.id] ?? null}
												/>
											{/if}
										{/each}

										{#if draftsByIssue[subIssue.id]?.length}
											{#each draftsByIssue[subIssue.id].filter((draft) => !(messagesByIssue[subIssue.id] ?? []).some((message) => message.id === draft.message_id)) as draft}
												<EmailMessageWithDraft
													message={{
														id: draft.message_id,
														subject: draft.subject,
														message: '',
														direction: 'outbound',
														timestampLabel: formatTimestamp(draft.updated_at)
													}}
													{draft}
												/>
											{/each}
										{/if}

										{#each (logsByIssue[subIssue.id] ?? []).filter(l => l.type !== 'email_inbound' && l.type !== 'email_outbound') as log}
											<div class="flex items-start gap-3 py-2 text-xs text-neutral-500">
												<span class="mt-0.5 h-1.5 w-1.5 rounded-full bg-neutral-300 shrink-0"></span>
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
								</details>
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>

	<aside class="flex w-1/5 border-l border-neutral-200">
		<div class="flex w-full flex-col px-6 py-2 transition-opacity duration-150" class:opacity-0={!$pageReady}>
			<div class="space-y-4 text-sm text-neutral-600">
				<div class="flex items-center gap-2 pb-2">
					<span class="text-neutral-400">{issueId}</span>
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
