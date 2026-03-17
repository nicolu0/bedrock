<script>
	// @ts-nocheck
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import { getContext } from 'svelte';
	import {
		issuesCache,
		primeIssuesCache,
		buildSectionsFromIssues
	} from '$lib/stores/issuesCache.js';

	export let data;

	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';

	$: _resolvedSections =
		$issuesCache?.workspace === workspaceSlug && $issuesCache?.data?.issues != null
			? buildSectionsFromIssues(
					$issuesCache.data.issues.filter((i) => slugify(i.property) === $page.params.property)
				)
			: null;

	$: sections = _resolvedSections ?? [];

	$: {
		if (data.issuesData instanceof Promise) {
			const loadStartedAt = Date.now();
			data.issuesData.then((d) => {
				if (browser) primeIssuesCache($page.params.workspace, d, loadStartedAt);
			});
		} else if (data.issuesData) {
			if (browser) primeIssuesCache($page.params.workspace, data.issuesData);
		}
	}

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
			return [{ ...item, isSubIssue: item.isSubIssue ?? false }, ...subRows];
		});
		return { ...section, rows };
	});

	const slugify = (value) => {
		if (!value) return '';
		return value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
	};

	const getIssueHref = (item) => {
		if (!item) return undefined;
		const slug = slugify(item.title);
		const readableId = item.readableId;
		if (!readableId) return undefined;
		return `${basePath}/issue/${readableId}/${slug}?from=property-issues`;
	};

	const getSectionGradientStyle = (statusClass) => {
		if (!statusClass) return '';
		if (statusClass.includes('orange')) {
			return 'background-image: linear-gradient(90deg, rgba(255, 237, 213, 0.16), rgba(255, 237, 213, 0.06), transparent);';
		}
		if (statusClass.includes('emerald')) {
			return 'background-image: linear-gradient(90deg, rgba(209, 250, 229, 0.14), rgba(209, 250, 229, 0.05), transparent);';
		}
		return '';
	};
</script>

<div>
	{#if _resolvedSections === null}
		<div class="divide-y divide-neutral-100">
			{#each { length: 4 } as _}
				<div class="flex items-center gap-3 px-6 py-2">
					<div class="skeleton h-3 w-3 flex-shrink-0 rounded-full"></div>
					<div class="skeleton h-4 w-2/5"></div>
					<div class="skeleton ml-auto h-5 w-28 rounded-full"></div>
					<div class="skeleton h-5 w-5 rounded-full"></div>
				</div>
			{/each}
		</div>
	{:else if expandedSections.length === 0}
		<div class="border-t border-neutral-200"></div>
		<div class="px-6 py-3 text-sm text-neutral-400">No issues yet.</div>
	{:else}
		<div class="divide-y divide-neutral-100">
			{#each expandedSections as section}
				<div>
					<div
						class="flex items-center justify-between border-y border-neutral-200 bg-stone-50 px-6 py-2 text-sm text-neutral-600"
						style={getSectionGradientStyle(section.statusClass)}
					>
						<div class="flex items-center gap-3">
							<span class={`h-3.5 w-3.5 rounded-full border-[1.5px] ${section.statusClass}`}></span>
							<span class="text-sm text-neutral-700">{section.label}</span>
							<span class="text-sm text-neutral-400">{section.count}</span>
						</div>
						<div class="h-4 w-4"></div>
					</div>
					<div>
						{#each section.rows as item}
							<a
								class="block w-full px-6 py-2 text-left transition hover:bg-stone-50"
								href={getIssueHref(item)}
								data-sveltekit-preload-data="hover"
							>
								<div class="flex items-center justify-between gap-4">
									<div class="flex items-center gap-3">
										<span class={`h-3.5 w-3.5 rounded-full border-[1.5px] ${section.statusClass}`}
										></span>
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
											<span class="px-2 py-0.5">{item.unit}</span>
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
