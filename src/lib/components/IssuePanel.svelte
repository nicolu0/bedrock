<script>
	// @ts-nocheck
	import { createEventDispatcher, onMount } from 'svelte';
	import { page } from '$app/stores';
	import { supabase } from '$lib/supabaseClient.js';
	import EmailMessageWithDraft from './EmailMessageWithDraft.svelte';
	import AppfolioDraftMessage from './AppfolioDraftMessage.svelte';

	export let issueId;
	export let seedIssue = null;
	export let activityData;
	export let activityLogsData;
	export let vendors = [];
	export let people = [];
	export let allIssues = [];

	const dispatch = createEventDispatcher();

	const statusConfig = {
		in_progress: { label: 'In Progress', statusClass: 'border-orange-500 text-orange-600' },
		todo: { label: 'Todo', statusClass: 'border-neutral-500 text-neutral-700' },
		done: { label: 'Done', statusClass: 'border-emerald-500 text-emerald-700' }
	};

	let issue = null;
	let subIssues = [];
	let subIssuesOpen = true;
	let activityOpen = {};
	let appfolioEnabled = false;
	$: if (typeof window !== 'undefined') {
		appfolioEnabled = window.localStorage.getItem(APPFOLIO_KEY) === 'true';
	}

	const APPFOLIO_KEY = 'appfolio_enabled';

	const syncAppfolioSettings = () => {
		if (typeof window === 'undefined') return;
		const enabled = window.localStorage.getItem(APPFOLIO_KEY) === 'true';
		appfolioEnabled = enabled;
	};

	let _lastExternalId = null;
	$: if (issueId && issueId !== _lastExternalId) {
		_lastExternalId = issueId;
		loadIssue(issueId);
	}

	function navigateTo(id) {
		loadIssue(id);
	}

	function handleClose() {
		if (issue?.parent_id) {
			loadIssue(issue.parent_id);
		} else {
			dispatch('close');
		}
	}

	onMount(() => {
		syncAppfolioSettings();
		const handleStorage = (event) => {
			if (event.key === APPFOLIO_KEY) {
				syncAppfolioSettings();
			}
		};
		window.addEventListener('storage', handleStorage);
		return () => window.removeEventListener('storage', handleStorage);
	});

	async function loadIssue(id) {
		console.log('[IssuePanel] loadIssue called', { id, seedIssue });
		issue =
			seedIssue && seedIssue.id === id
				? {
						id: seedIssue.id,
						name: seedIssue.name,
						status: seedIssue.status,
						urgent: seedIssue.urgent ?? false,
						description: null,
						parent_id: seedIssue.parent_id ?? null
					}
				: null;
		console.log('[IssuePanel] seed issue set', { issue });
		subIssues = [];

		const [{ data: iss }, { data: subs }] = await Promise.all([
			supabase
				.from('issues')
				.select('id, name, status, urgent, description, parent_id')
				.eq('id', id)
				.maybeSingle(),
			supabase.from('issues').select('id, name, status, urgent, assignee_id').eq('parent_id', id)
		]);

		console.log('[IssuePanel] DB result', { iss, subs });
		if (iss) issue = iss;
		subIssues = subs ?? [];
	}

	$: messagesByIssue = activityData?.messagesByIssue ?? {};
	$: emailDraftsByMessageId = activityData?.emailDraftsByMessageId ?? {};
	$: draftIssueIds = activityData?.draftIssueIds ?? [];
	$: logsByIssue = activityLogsData?.logsByIssue ?? {};

	const getAppfolioApprovedBy = (id) => {
		const list = logsByIssue?.[id] ?? [];
		const last = [...list].reverse().find((entry) => entry?.type === 'appfolio_approved');
		return last?.data?.approved_by ?? null;
	};

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

	$: draftsByIssue = Object.values(emailDraftsByMessageId).reduce((acc, d) => {
		if (!d?.issue_id) return acc;
		const key = d.message_id ?? d.id;
		if (key && suppressedDraftKeys.has(key)) return acc;
		if (!acc[d.issue_id]) acc[d.issue_id] = [];
		acc[d.issue_id].push(d);
		return acc;
	}, {});

	const applyMessageDelta = (msg) => {
		if (!msg?.issue_id) return;
		const list = messagesByIssue[msg.issue_id] ?? [];
		const idx = list.findIndex((m) => m.id === msg.id);
		const updated =
			idx >= 0 ? [...list.slice(0, idx), msg, ...list.slice(idx + 1)] : [...list, msg];
		messagesByIssue = { ...messagesByIssue, [msg.issue_id]: updated };
	};

	const removeMessageFromCache = (msg) => {
		if (!msg?.id || !msg?.issue_id) return;
		const list = messagesByIssue[msg.issue_id] ?? [];
		messagesByIssue = { ...messagesByIssue, [msg.issue_id]: list.filter((m) => m.id !== msg.id) };
	};

	const applyDraftDelta = (draft) => {
		if (!draft) return;
		const key = draft.message_id ?? draft.id;
		if (!key) return;
		emailDraftsByMessageId = { ...emailDraftsByMessageId, [key]: draft };
		if (draft.issue_id && !draftIssueIds.includes(draft.issue_id)) {
			draftIssueIds = [...draftIssueIds, draft.issue_id];
		}
	};

	const removeDraftFromCache = (draft) => {
		if (!draft) return;
		const key = draft.message_id ?? draft.id;
		if (!key) return;
		const { [key]: _, ...rest } = emailDraftsByMessageId;
		emailDraftsByMessageId = rest;
	};

	const handleDraftSent = (detail) => {
		if (!detail) return;
		const { status, message, tempId, issueId, draft, draftKey } = detail;
		const targetIssueId = issueId ?? message?.issue_id ?? draft?.issue_id ?? null;
		if (status === 'optimistic') {
			suppressDraftKey(draftKey ?? draft?.message_id ?? draft?.id);
			if (message) applyMessageDelta(message);
			if (draft) removeDraftFromCache(draft);
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

	$: statusMeta = statusConfig[issue?.status ?? 'todo'] ?? statusConfig.todo;

	let parentIssueCache = {};
	$: parentIssue = (() => {
		const pid = issue?.parent_id;
		if (!pid) return null;
		return allIssues.find((i) => i.id === pid) ?? parentIssueCache[pid] ?? null;
	})();
	$: if (issue?.parent_id && !allIssues.find((i) => i.id === issue.parent_id) && !parentIssueCache[issue.parent_id]) {
		supabase
			.from('issues')
			.select('id, name, status')
			.eq('id', issue.parent_id)
			.maybeSingle()
			.then(({ data }) => {
				if (data) parentIssueCache = { ...parentIssueCache, [data.id]: data };
			});
	}

	$: subIssueProgress = `${subIssues.filter((item) => item.status === 'done').length}/${subIssues.length}`;

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

	const toggleActivity = (id) => {
		activityOpen = { ...activityOpen, [id]: !(activityOpen[id] ?? true) };
	};
</script>

<svelte:window on:keydown={(e) => { if (e.key === 'Escape') handleClose(); }} />

<div class="flex h-full flex-col">
	<!-- Header -->
	<div
		class="flex items-center justify-between border-b border-neutral-200 px-6 py-3 text-sm text-neutral-600"
	>
		<div class="flex min-w-0 items-center gap-2">
			{#if parentIssue}
				<button
					type="button"
					class="shrink-0 text-neutral-700 hover:underline"
					on:click={() => navigateTo(parentIssue.id)}
				>{parentIssue.name}</button>
				<span class="text-neutral-300">›</span>
			{/if}
			<span class={`h-3 w-3 shrink-0 rounded-full border ${statusMeta.statusClass}`}></span>
			<span class="truncate text-neutral-500">{issue?.name ?? ''}</span>
		</div>
		<button
			on:click={handleClose}
			class="ml-3 shrink-0 text-neutral-400 transition hover:text-neutral-600"
			aria-label="Close panel"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="16"
				height="16"
				fill="currentColor"
				viewBox="0 0 16 16"
			>
				<path
					d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"
				/>
			</svg>
		</button>
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-y-auto px-10 py-8">
		<div class="flex flex-wrap items-start justify-between gap-6">
			<div class="min-w-0">
				<h1 class="text-2xl font-semibold text-neutral-900">{issue?.name ?? ''}</h1>
				<div class="mt-2 text-sm text-neutral-500">
					{issue?.description || 'Add description...'}
				</div>
			</div>
		</div>
		<div class="mt-6"></div>

		{#if parentIssue}
			<div class="mt-2 flex items-center gap-2 text-sm">
				<span class="text-xs text-neutral-400">Parent</span>
				<button
					type="button"
					class="flex items-center gap-1.5 text-neutral-600 hover:underline"
					on:click={() => navigateTo(parentIssue.id)}
				>
					<span class="h-2.5 w-2.5 shrink-0 rounded-full border border-neutral-400"></span>
					<span>{parentIssue.name}</span>
				</button>
			</div>
		{/if}

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
								{@const assigneePerson = people.find((p) => p.user_id === subIssue.assignee_id)}
								{@const initials = assigneePerson?.name ? assigneePerson.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() : ''}
								<button
									type="button"
									on:click={() => loadIssue(subIssue.id)}
									class="flex w-full items-center justify-between px-3 py-3 text-sm transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-200 focus-visible:outline-none"
								>
									<div class="flex items-center gap-3">
										<span class={`h-4 w-4 shrink-0 rounded-full border ${statusConfig[subIssue.status ?? 'todo']?.statusClass ?? 'border-neutral-300'}`}></span>
										<span class="text-left text-neutral-800">{subIssue.name}</span>
									</div>
									{#if initials}
										<div class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-medium text-neutral-600">{initials}</div>
									{:else}
										<div class="h-6 w-6 shrink-0 rounded-full bg-neutral-100"></div>
									{/if}
								</button>
							{/each}
						</div>
					</div>
				</div>
			</div>
		{/if}

		<div class="mt-8 border-t border-neutral-200 pt-6">
			<div class="flex items-center justify-between">
				<h2 class="text-base font-semibold text-neutral-800">Activity</h2>
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
										{#if appfolioEnabled}
											<svg
												width="18"
												height="18"
												viewBox="0 0 1024 1024"
												fill="none"
												xmlns="http://www.w3.org/2000/svg"
											>
												<circle cx="512" cy="512" r="512" fill="#007bc7" />
												<path
													d="M582.49 516a77.29 77.29 0 0 0 15.31-4.9v31.72c0 69.9-67.12 85.21-93 85.21-35.29 0-73.3-18.75-73.3-49.15 0-32.73 29.44-43 91.33-52.48 16.08-2.4 42.3-7.06 59.66-10.4zm192.2-4c0 141.38-117.61 256-262.69 256S249.31 653.38 249.31 512 366.92 256 512 256s262.69 114.62 262.69 256zm-120.57-31.23c0-10.41-.33-20.26-.33-28.89 0-54.88-26.32-82.32-48.42-95.68a147.66 147.66 0 0 0-73.86-18.53c-54.77 0-95.12 15.42-120.05 45.75a115.6 115.6 0 0 0-24.93 62.78 9.53 9.53 0 0 0 0 1.78 29.28 29.28 0 0 0 29.55 26.55 27.27 27.27 0 0 0 29.72-23c6.35-29.5 20.43-56.83 80.59-56.83 31.89 0 52.71 6.57 63.62 20.09a39 39 0 0 1 10.19 30.28c0 10-3.79 22.26-33.39 28.78-19.2 4.17-39.41 6.51-58.94 8.74l-9.35 1.11c-110.77 13.1-127.47 71.54-127.47 105.16 0 61 73.36 95.51 126.34 97.18h9.8a153.19 153.19 0 0 0 58.66-10.3l1.61-.67a136.14 136.14 0 0 0 79.59-81c8.63-23.25 7.85-71.07 7.07-113.3z"
													fill="white"
												/>
											</svg>
										{:else if appfolioEnabled}
											<svg
												width="18"
												height="18"
												viewBox="0 0 1024 1024"
												fill="none"
												xmlns="http://www.w3.org/2000/svg"
											>
												<circle cx="512" cy="512" r="512" fill="#007bc7" />
												<path
													d="M582.49 516a77.29 77.29 0 0 0 15.31-4.9v31.72c0 69.9-67.12 85.21-93 85.21-35.29 0-73.3-18.75-73.3-49.15 0-32.73 29.44-43 91.33-52.48 16.08-2.4 42.3-7.06 59.66-10.4zm192.2-4c0 141.38-117.61 256-262.69 256S249.31 653.38 249.31 512 366.92 256 512 256s262.69 114.62 262.69 256zm-120.57-31.23c0-10.41-.33-20.26-.33-28.89 0-54.88-26.32-82.32-48.42-95.68a147.66 147.66 0 0 0-73.86-18.53c-54.77 0-95.12 15.42-120.05 45.75a115.6 115.6 0 0 0-24.93 62.78 9.53 9.53 0 0 0 0 1.78 29.28 29.28 0 0 0 29.55 26.55 27.27 27.27 0 0 0 29.72-23c6.35-29.5 20.43-56.83 80.59-56.83 31.89 0 52.71 6.57 63.62 20.09a39 39 0 0 1 10.19 30.28c0 10-3.79 22.26-33.39 28.78-19.2 4.17-39.41 6.51-58.94 8.74l-9.35 1.11c-110.77 13.1-127.47 71.54-127.47 105.16 0 61 73.36 95.51 126.34 97.18h9.8a153.19 153.19 0 0 0 58.66-10.3l1.61-.67a136.14 136.14 0 0 0 79.59-81c8.63-23.25 7.85-71.07 7.07-113.3z"
													fill="white"
												/>
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
							{/if}
							<div class="space-y-3 pl-11">
								{#each collectMessagesForIssue(issueId) as message}
									<EmailMessageWithDraft
										message={{
											...message,
											timestampLabel: formatTimestamp(message.timestamp)
										}}
										draft={null}
										{people}
									/>
								{/each}
								{#each draftsByIssue[issueId] ?? [] as draft (draft.id ?? draft.message_id)}
									{#if appfolioEnabled}
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
											{people}
											on:sent={(e) => {
												handleDraftSent(e.detail);
												if (e.detail?.status === 'confirmed') dispatch('resolved');
											}}
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
											{people}
											on:sent={(e) => {
												handleDraftSent(e.detail);
												if (e.detail?.status === 'confirmed') dispatch('resolved');
											}}
										/>
									{/if}
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
								{:else if log.type === 'appfolio_approved'}
									Approved by {log?.data?.approved_by ?? 'Unknown'} · {formatTimestamp(
										log.created_at
									)}
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
														{people}
													/>
												{/each}
												{#each draftsByIssue[subIssue.id] ?? [] as draft (draft.id ?? draft.message_id)}
													{#if appfolioEnabled}
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
															{people}
															on:sent={(e) => {
																handleDraftSent(e.detail);
																if (e.detail?.status === 'confirmed') dispatch('resolved');
															}}
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
															{people}
															on:sent={(e) => {
																handleDraftSent(e.detail);
																if (e.detail?.status === 'confirmed') dispatch('resolved');
															}}
														/>
													{/if}
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
														{:else if log.type === 'appfolio_approved'}
															Approved by {log?.data?.approved_by ?? 'Unknown'} · {formatTimestamp(
																log.created_at
															)}
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
