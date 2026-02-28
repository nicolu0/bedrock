<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { issuesCache, primeIssuesCache } from '$lib/stores/issuesCache';
	import { goto } from '$app/navigation';

	export let data;

	const tabs = ['Assigned', 'Subscribed', 'Activity'];

	$: sections = $issuesCache.data?.sections ?? [];
	$: isLoading = sections.length === 0 && $issuesCache.loading;
	$: expandedSections = sections.map((section) => {
		const rows = section.items.flatMap((item) => {
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
		});
		return { ...section, rows };
	});

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';

	// Prime cache from streaming server data (handles both resolved value and client Promise)
	$: if (browser && data.sections) {
		const prime = (s) => {
			if (s?.length && (!$issuesCache.data || $issuesCache.workspace !== workspaceSlug)) {
				primeIssuesCache(workspaceSlug, { sections: s });
			}
		};
		if (data.sections instanceof Promise) {
			data.sections.then(prime);
		} else {
			prime(data.sections);
		}
	}

	const slugify = (value) => {
		if (!value) return 'issue';
		return value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
	};

	const getIssueHref = (issueId, title) => {
		const slug = slugify(title);
		return `${basePath}/issue/${issueId}/${slug}`;
	};
</script>

<div>
	<div class="border-b border-neutral-100 px-6 py-2">
		<h1 class="text-sm font-normal text-neutral-700">My issues</h1>
	</div>
	<div class="flex items-center justify-between px-6 py-2">
		<div class="flex items-center gap-2">
			{#each tabs as tab}
				<button
					class={`rounded-md border px-2.5 py-1 text-xs transition ${
						tab === 'Assigned'
							? 'border-neutral-200 bg-neutral-100 text-neutral-700'
							: 'border-transparent text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700'
					}`}
					type="button"
				>
					{tab}
				</button>
			{/each}
		</div>
		<div class="flex items-center gap-4 text-xs text-neutral-500">
			<button class="inline-flex items-center gap-2 hover:text-neutral-800" type="button">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="16"
					height="16"
					fill="currentColor"
					viewBox="0 0 16 16"
				>
					<path
						d="M6 10.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"
					/>
				</svg>
				Filter
			</button>
			<button class="inline-flex items-center gap-2 hover:text-neutral-800" type="button">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="16"
					height="16"
					fill="currentColor"
					viewBox="0 0 16 16"
				>
					<path
						d="M4 3.5a.5.5 0 0 1 .5-.5H12a.5.5 0 0 1 0 1H4.5a.5.5 0 0 1-.5-.5m0 9a.5.5 0 0 1 .5-.5H12a.5.5 0 0 1 0 1H4.5a.5.5 0 0 1-.5-.5m0-4.5a.5.5 0 0 1 .5-.5H12a.5.5 0 0 1 0 1H4.5a.5.5 0 0 1-.5-.5m-2.5-3a1 1 0 1 1 0-2 1 1 0 0 1 0 2m0 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2m0-4.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2"
					/>
				</svg>
				Display
			</button>
		</div>
	</div>

	{#if isLoading}
		<div class="px-6 py-8 text-sm text-neutral-400">Loading issues...</div>
	{:else}
		<div class="divide-y divide-neutral-100">
			{#each expandedSections as section}
				<div>
					<div
						class="flex items-center justify-between border-y border-neutral-200 bg-stone-50 px-6 py-2 text-sm text-neutral-600"
					>
						<div class="flex items-center gap-3">
							<span class={`h-3 w-3 rounded-full border ${section.statusClass}`}></span>
							<span class="text-sm text-neutral-700">{section.label}</span>
							<span class="text-sm text-neutral-400">{section.count}</span>
						</div>
						<div class="h-4 w-4"></div>
					</div>
					<div>
						{#each section.rows as item}
							<a
								class="block w-full px-6 py-2 text-left transition hover:bg-stone-50"
								href={getIssueHref(item.issueId, item.title)}
								data-sveltekit-preload-data="hover"
							>
								<div class="flex items-center justify-between gap-4">
									<div class="flex items-center gap-3">
										<span class={`h-3 w-3 rounded-full border ${section.statusClass}`}></span>
										{#if item.isSubIssue}
											<div class="flex items-center gap-2 text-sm">
												<span class="text-neutral-600">{item.title}</span>
												<span class="text-neutral-300">›</span>
												<span class="text-neutral-400">{item.parentTitle}</span>
											</div>
										{:else}
											<span class="text-sm text-neutral-800">{item.title}</span>
										{/if}
									</div>
									<div class="flex items-center gap-2">
										<div
											class="inline-flex items-center overflow-hidden rounded-full border border-neutral-200 bg-white text-xs text-neutral-500"
										>
											<span class="px-2 py-0.5">{item.property}</span>
											<span class="border-l border-neutral-200 px-2 py-0.5">{item.unit}</span>
										</div>
										{#each Array(item.assignees) as _}
											<div class="h-5 w-5 rounded-full bg-neutral-200"></div>
										{/each}
									</div>
								</div>
							</a>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
