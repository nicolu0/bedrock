<script>
	// @ts-nocheck
	import { createEventDispatcher } from 'svelte';
	import { page } from '$app/stores';
	import { supabase } from '$lib/supabaseClient.js';
	import EmailMessageWithDraft from './EmailMessageWithDraft.svelte';

	export let issueId;
	export let seedIssue = null;
	export let activityData;
	export let activityLogsData;
	export let vendors = [];
	export let allIssues = [];

	const dispatch = createEventDispatcher();

	const statusConfig = {
		in_progress: { label: 'In Progress', statusClass: 'border-amber-500 text-amber-600' },
		todo: { label: 'Todo', statusClass: 'border-neutral-500 text-neutral-700' },
		done: { label: 'Done', statusClass: 'border-emerald-500 text-emerald-700' }
	};

	let issue = null;
	let subIssues = [];
	let subIssuesOpen = true;
	let activityOpen = {};

	$: if (issueId) loadIssue(issueId);

	async function loadIssue(id) {
		console.log('[IssuePanel] loadIssue called', { id, seedIssue });
		issue =
			seedIssue && seedIssue.id === id
				? { id: seedIssue.id, name: seedIssue.name, status: seedIssue.status, description: null, parent_id: seedIssue.parent_id ?? null }
				: null;
		console.log('[IssuePanel] seed issue set', { issue });
		subIssues = [];

		const [{ data: iss }, { data: subs }] = await Promise.all([
			supabase.from('issues').select('id, name, status, description, parent_id').eq('id', id).maybeSingle(),
			supabase.from('issues').select('id, name, status').eq('parent_id', id)
		]);

		console.log('[IssuePanel] DB result', { iss, subs });
		if (iss) issue = iss;
		subIssues = subs ?? [];
	}

	$: messagesByIssue = activityData?.messagesByIssue ?? {};
	$: emailDraftsByMessageId = activityData?.emailDraftsByMessageId ?? {};
	$: draftsByIssue = Object.values(emailDraftsByMessageId).reduce((acc, d) => {
		if (!d?.issue_id) return acc;
		if (!acc[d.issue_id]) acc[d.issue_id] = [];
		acc[d.issue_id].push(d);
		return acc;
	}, {});
	$: draftIssueIds = activityData?.draftIssueIds ?? [];
	$: logsByIssue = activityLogsData?.logsByIssue ?? {};

	$: statusMeta = statusConfig[issue?.status ?? 'todo'] ?? statusConfig.todo;
	$: parentIssue = (() => {
		const pid = issue?.parent_id;
		const found = pid ? allIssues.find((i) => i.id === pid) : null;
		console.log('[IssuePanel] parentIssue computation', { parent_id: pid, allIssuesCount: allIssues.length, found });
		return found ?? null;
	})();

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

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="flex items-center justify-between border-b border-neutral-200 px-6 py-3 text-sm text-neutral-600">
		<div class="flex min-w-0 items-center gap-2">
			{#if parentIssue}
				<span class="shrink-0 text-neutral-700">{parentIssue.name}</span>
				<span class="text-neutral-300">›</span>
			{/if}
			<span class={`h-3 w-3 shrink-0 rounded-full border ${statusMeta.statusClass}`}></span>
			<span class="truncate text-neutral-500">{issue?.name ?? ''}</span>
		</div>
		<button
			on:click={() => dispatch('close')}
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
				<a
					href={`/${$page.params.workspace}/issue/${parentIssue.id}/${slugify(parentIssue.name ?? '')}?from=inbox`}
					class="flex items-center gap-1.5 text-neutral-600 hover:underline"
				>
					<span class="h-2.5 w-2.5 shrink-0 rounded-full border border-neutral-400"></span>
					<span>{parentIssue.name}</span>
				</a>
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
								<a
									href={`/${$page.params.workspace}/issue/${subIssue.id}/${slugify(subIssue.name)}?from=inbox`}
									class="flex items-center justify-between px-3 py-3 text-sm transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-200"
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
