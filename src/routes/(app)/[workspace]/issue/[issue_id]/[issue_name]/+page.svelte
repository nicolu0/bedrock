<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { issuesCache } from '$lib/stores/issuesCache';

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

	$: issueId = $page.params.issue_id ?? 'HUB-1';
	$: issueNameSlug = $page.params.issue_name ?? 'issues-page-layout';
	$: issueRecord =
		($issuesCache.data?.issues ?? []).find((issue) => String(issue.id) === String(issueId)) ?? null;
	$: issueName =
		issueRecord?.name ??
		(issueNameSlug
			? issueNameSlug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
			: 'Issues Page Layout');
	$: issueDescription = issueRecord?.description ?? '';
	$: statusKey = issueRecord?.status ?? 'todo';
	$: statusMeta = statusConfig[statusKey] ?? statusConfig.todo;
	$: assigneeName = $issuesCache.data?.assignee?.name ?? 'Unassigned';
	$: sectionIssue = ($issuesCache.data?.sections ?? [])
		.flatMap((section) => section.items ?? [])
		.find((item) => String(item.id) === String(issueId));
	$: rawSubIssues = ($issuesCache.data?.issues ?? []).filter(
		(issue) => String(issue.parent_id ?? issue.parentId ?? '') === String(issueId)
	);
	$: subIssues = rawSubIssues.length
		? rawSubIssues
		: (sectionIssue?.subIssues ?? []).map((item) => ({
				...item,
				name: item.name ?? item.title
			}));
	$: subIssueProgress = `${subIssues.filter((item) => item.status === 'done').length}/${
		subIssues.length
	}`;
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
		</div>

		<div class="flex-1 px-10 py-8">
			<div class="flex flex-wrap items-start justify-between gap-6">
				<div class="min-w-0">
					<h1 class="text-2xl font-semibold text-neutral-900">{issueName}</h1>
					<div class="mt-2 text-sm text-neutral-500">
						{issueDescription || 'Add description...'}
					</div>
				</div>
				<div class="flex items-center gap-4 text-sm text-neutral-600">
					<div class="flex items-center gap-2">
						<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
						<span>{assigneeName}</span>
					</div>
					<div class="flex items-center gap-2">
						<span class={`h-3 w-3 rounded-full border ${statusMeta.statusClass}`}></span>
						<span>{statusMeta.label}</span>
					</div>
				</div>
			</div>
			<div class="mt-6 flex items-center gap-3 text-sm text-neutral-600">
				<button
					class="inline-flex items-center gap-2 rounded-md px-2 py-1 transition hover:bg-neutral-100"
					type="button"
				>
					<span class="text-neutral-400">+</span>
					Add sub-issues
				</button>
				<div class="ml-auto text-neutral-400">@</div>
			</div>

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
						<div class="flex items-center gap-2 text-neutral-400">
							<button class="rounded-md p-1 transition hover:bg-neutral-100" type="button">
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									fill="currentColor"
									viewBox="0 0 16 16"
								>
									<path
										d="M8 1a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2H9v5a1 1 0 1 1-2 0V9H2a1 1 0 1 1 0-2h5V2a1 1 0 0 1 1-1"
									/>
								</svg>
							</button>
						</div>
					</div>
					<div class="mt-3 space-y-2">
						{#each subIssues as subIssue}
							<div
								class="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm"
							>
								<div class="flex items-center gap-3">
									<span class="h-4 w-4 rounded-full border border-neutral-300"></span>
									<span class="text-neutral-800">{subIssue.name}</span>
								</div>
								<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="mt-8 border-t border-neutral-200 pt-6">
				<div class="flex items-center justify-between">
					<h2 class="text-base font-semibold text-neutral-800">Activity</h2>
					<div class="text-sm text-neutral-400">Unsubscribe</div>
				</div>
				<div class="mt-4 text-sm text-neutral-500">No activity yet.</div>
			</div>
		</div>
	</div>
</div>
