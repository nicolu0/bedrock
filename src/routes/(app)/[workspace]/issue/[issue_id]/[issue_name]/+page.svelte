<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { issuesCache } from '$lib/stores/issuesCache';
	import EmailMessageWithDraft from '$lib/components/EmailMessageWithDraft.svelte';

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

	$: issueId = data?.issue?.id ?? $page.params.issue_id ?? 'HUB-1';
	$: issueName = data?.issue?.name ?? 'Issue';
	$: issueDescription = data?.issue?.description ?? '';
	$: statusKey = data?.issue?.status ?? 'todo';
	$: statusMeta = statusConfig[statusKey] ?? statusConfig.todo;
	$: assigneeName = data?.assignee?.name ?? 'Unassigned';
	$: subIssues = data?.subIssues ?? [];
	$: subIssueProgress = `${subIssues.filter((item) => item.status === 'done').length}/${
		subIssues.length
	}`;
	$: messagesByIssue = data?.messagesByIssue ?? {};
	$: emailDraftsByMessageId = data?.emailDraftsByMessageId ?? {};
	$: draftIssueIds = data?.draftIssueIds ?? [];

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
			return messages.length || hasDraft;
		}) || (messagesByIssue[issueId]?.length ?? 0) > 0;

	const slugify = (value) =>
		(value ?? '')
			.toString()
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');

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
</script>

<div class="flex h-full">
	<div class="flex min-w-0 flex-1 flex-col">
		<div
			class="flex items-center justify-between border-b border-neutral-100 px-6 py-2 text-sm text-neutral-600"
		>
			<div class="flex items-center gap-2">
				<span class="text-neutral-700">My issues</span>
				<span class="text-neutral-300">›</span>
				<span class="h-3 w-3 rounded-full border border-amber-500"></span>
				<span class="text-neutral-700">{issueId}</span>
				<span class="text-neutral-500">{issueName}</span>
			</div>
			<div class="flex items-center gap-2">
				{#if totalIssues > 0 && currentIndex >= 0}
					<span class="text-xs text-neutral-500">{currentIndex + 1} / {totalIssues}</span>
				{/if}
				<button
					class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-40"
					type="button"
					disabled={!nextIssue}
					on:click={() => nextIssue && goto(getIssueHref(nextIssue.issueId, nextIssue.title))}
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
				</button>
				<button
					class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-40"
					type="button"
					disabled={!prevIssue}
					on:click={() => prevIssue && goto(getIssueHref(prevIssue.issueId, prevIssue.title))}
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
				</button>
			</div>
		</div>

		<div class="flex-1 px-10 py-8">
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
								href={`/${$page.params.workspace}/issue/${subIssue.id}/${slugify(subIssue.name)}`}
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
									<EmailMessageWithDraft
										message={{
											...message,
											timestampLabel: formatTimestamp(message.timestamp)
										}}
										draft={emailDraftsByMessageId[message.id]}
									/>
									{#if false}
										<div class="overflow-hidden rounded-md border border-neutral-100 bg-white">
											<div class="px-3 py-2">
												<div class="flex items-center justify-between text-xs text-neutral-400">
													<span>
														{message.direction === 'outbound' ? 'Outbound' : 'Inbound'}
														{#if message.subject}
															· {message.subject}
														{/if}
													</span>
													<span>{formatTimestamp(message.timestamp)}</span>
												</div>
												<div class="mt-1 text-neutral-700">{message.message}</div>
											</div>
											{#if emailDraftsByMessageId[message.id]}
												<div class="border-t border-neutral-100 bg-neutral-50 px-3 py-2">
													<div class="flex items-center justify-between text-xs text-neutral-400">
														<span>
															Draft reply
															{#if emailDraftsByMessageId[message.id]?.recipient}
																· {emailDraftsByMessageId[message.id].recipient}
															{/if}
														</span>
														<span></span>
													</div>
													<div class="mt-2 flex items-end justify-between gap-3">
														<div class="whitespace-pre-wrap text-neutral-700">
															{emailDraftsByMessageId[message.id].body}
														</div>
														<div class="flex items-center">
															<button
																class="inline-flex h-10 w-10 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800"
																type="button"
															>
																<svg
																	xmlns="http://www.w3.org/2000/svg"
																	width="18"
																	height="18"
																	fill="currentColor"
																	viewBox="0 0 16 16"
																>
																	<path
																		d="M8 12a.5.5 0 0 0 .5-.5V4.707l2.147 2.147a.5.5 0 0 0 .707-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 4.707V11.5A.5.5 0 0 0 8 12z"
																	/>
																</svg>
															</button>
														</div>
													</div>
												</div>
											{/if}
										</div>
									{/if}
								{/each}
							</div>
						{/if}
						{#each subIssues as subIssue}
							{#if (messagesByIssue[subIssue.id]?.length ?? 0) || draftIssueIds.includes(subIssue.id)}
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
											<EmailMessageWithDraft
												message={{
													...message,
													timestampLabel: formatTimestamp(message.timestamp)
												}}
												draft={emailDraftsByMessageId[message.id]}
											/>
											{#if false}
												<div class="overflow-hidden rounded-md border border-neutral-100 bg-white">
													<div class="px-3 py-2">
														<div class="flex items-center justify-between text-xs text-neutral-400">
															<span>
																{message.direction === 'outbound' ? 'Outbound' : 'Inbound'}
																{#if message.subject}
																	· {message.subject}
																{/if}
															</span>
															<span>{formatTimestamp(message.timestamp)}</span>
														</div>
														<div class="mt-1 text-neutral-700">{message.message}</div>
													</div>
													{#if emailDraftsByMessageId[message.id]}
														<div class="border-t border-neutral-100 bg-neutral-50 px-3 py-2">
															<div
																class="flex items-center justify-between text-xs text-neutral-400"
															>
																<span>
																	Draft reply
																	{#if emailDraftsByMessageId[message.id]?.recipient}
																		· {emailDraftsByMessageId[message.id].recipient}
																	{/if}
																</span>
																<span></span>
															</div>
															<div class="mt-2 flex items-end justify-between gap-3">
																<div class="whitespace-pre-wrap text-neutral-700">
																	{emailDraftsByMessageId[message.id].body}
																</div>
																<div class="flex items-center gap-2 text-neutral-400">
																	<button
																		class="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 bg-white transition hover:bg-neutral-100"
																		type="button"
																	>
																		<svg
																			xmlns="http://www.w3.org/2000/svg"
																			width="16"
																			height="16"
																			fill="currentColor"
																			viewBox="0 0 16 16"
																		>
																			<path
																				d="M.5 9.9a.5.5 0 0 0 .6.4l4.8-1.1 5.3 5.3c.3.3.9.1.9-.4l1.7-12c.1-.6-.5-1.1-1.1-.9l-12 1.7a.5.5 0 0 0-.4.6l1.4 5.8L.5 9.9z"
																			/>
																		</svg>
																	</button>
																	<button
																		class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800"
																		type="button"
																	>
																		<svg
																			xmlns="http://www.w3.org/2000/svg"
																			width="16"
																			height="16"
																			fill="currentColor"
																			viewBox="0 0 16 16"
																		>
																			<path
																				d="M15.854.146a.5.5 0 0 0-.55-.11l-14 5a.5.5 0 0 0 .02.95l5.31 1.77 1.77 5.31a.5.5 0 0 0 .95.02l5-14a.5.5 0 0 0-.5-.57zm-6.9 10.69-1.31-3.94 4.94-4.94-3.63 8.88z"
																			/>
																		</svg>
																	</button>
																</div>
															</div>
														</div>
													{/if}
												</div>
											{/if}
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
		<div class="flex w-full flex-col px-6 py-2">
			<div class="space-y-4 text-sm text-neutral-600">
				<div class="flex items-center gap-2 pb-2">
					<span class="text-neutral-400">HUB-2</span>
				</div>
				<div class="flex items-center gap-2">
					<div class="h-3.5 w-3.5 rounded-full bg-neutral-200"></div>
					<span>Andrew Chang</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="h-3.5 w-3.5 rounded-full border border-amber-500"></span>
					<span>{statusMeta.label}</span>
				</div>
			</div>
		</div>
	</aside>
</div>
