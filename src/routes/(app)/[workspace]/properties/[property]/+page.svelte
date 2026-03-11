<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { getContext } from 'svelte';
	import { issuesCache } from '$lib/stores/issuesCache';
	import { propertiesCache } from '$lib/stores/propertiesCache.js';

	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();

	const statusConfig = {
		in_progress: {
			id: 'in-progress',
			label: 'In Progress',
			statusClass: 'border-amber-500 text-amber-600'
		},
		todo: {
			id: 'todo',
			label: 'Todo',
			statusClass: 'border-neutral-500 text-neutral-700'
		},
		done: {
			id: 'done',
			label: 'Done',
			statusClass: 'border-emerald-500 text-emerald-700'
		}
	};

	const statusOrder = ['in_progress', 'todo', 'done'];
	const allowedStatuses = new Set(statusOrder);

	const normalizeStatus = (value) => {
		if (!value) return 'todo';
		const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
		if (normalized === 'in_progress') return 'in_progress';
		if (normalized === 'done' || normalized === 'completed' || normalized === 'complete')
			return 'done';
		if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
		return allowedStatuses.has(normalized) ? normalized : 'todo';
	};

	const slugify = (value) => {
		if (!value) return '';
		return value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
	};

	const buildSectionsFromIssues = (issues = []) => {
		const normalizedIssues = (issues ?? []).map((issue) => ({
			...issue,
			status: normalizeStatus(issue.status)
		}));
		const issuesById = new Map(normalizedIssues.map((issue) => [issue.id ?? issue.issueId, issue]));
		const childrenByParent = new Map();
		for (const issue of normalizedIssues) {
			const parentId = issue.parentId ?? issue.parent_id ?? null;
			if (!parentId) continue;
			if (!childrenByParent.has(parentId)) {
				childrenByParent.set(parentId, []);
			}
			childrenByParent.get(parentId).push(issue);
		}

		const topLevelIssues = normalizedIssues.filter((issue) => {
			const parentId = issue.parentId ?? issue.parent_id ?? null;
			return !parentId || !issuesById.has(parentId);
		});

		const sectionBuckets = new Map(
			statusOrder.map((status) => [status, { config: statusConfig[status], items: [] }])
		);

		for (const issue of topLevelIssues) {
			const status = issue.status ?? 'todo';
			const bucket = sectionBuckets.get(status);
			if (!bucket) continue;
			const issueId = issue.id ?? issue.issueId;
			const subIssues = (childrenByParent.get(issueId) ?? [])
				.filter((child) => (child.status ?? 'todo') === status)
				.map((subIssue) => ({
					id: subIssue.id,
					issueId: subIssue.issueId ?? subIssue.id,
					title: subIssue.title ?? subIssue.name,
					parentTitle: issue.title ?? issue.name,
					property: subIssue.property,
					unit: subIssue.unit,
					issueNumber: subIssue.issueNumber ?? subIssue.issue_number ?? null,
					readableId: subIssue.readableId ?? subIssue.readable_id ?? null,
					assignees: subIssue.assignees ?? 0
				}));
			bucket.items.push({
				id: issue.id,
				issueId: issue.issueId ?? issue.id,
				title: issue.title ?? issue.name,
				assignees: issue.assignees ?? 0,
				property: issue.property,
				unit: issue.unit,
				issueNumber: issue.issueNumber ?? issue.issue_number ?? null,
				readableId: issue.readableId ?? issue.readable_id ?? null,
				subIssues
			});
		}

		for (const issue of normalizedIssues) {
			const parentId = issue.parentId ?? issue.parent_id ?? null;
			if (!parentId) continue;
			const parent = issuesById.get(parentId);
			if (!parent) continue;
			if ((parent.status ?? 'todo') === (issue.status ?? 'todo')) continue;
			const bucket = sectionBuckets.get(issue.status ?? 'todo');
			if (!bucket) continue;
			bucket.items.push({
				id: issue.id,
				issueId: issue.issueId ?? issue.id,
				title: issue.title ?? issue.name,
				assignees: issue.assignees ?? 0,
				property: issue.property,
				unit: issue.unit,
				issueNumber: issue.issueNumber ?? issue.issue_number ?? null,
				readableId: issue.readableId ?? issue.readable_id ?? null,
				parentTitle: parent.title ?? parent.name,
				isSubIssue: true,
				subIssues: []
			});
		}

		return statusOrder
			.map((status) => {
				const bucket = sectionBuckets.get(status);
				const config = bucket?.config ?? statusConfig[status];
				const items = bucket?.items ?? [];
				return {
					id: config.id,
					label: config.label,
					count: items.length,
					statusClass: config.statusClass,
					items
				};
			})
			.filter((section) => section.count > 0);
	};

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: propertySlug = $page.params.property;

	$: properties =
		$propertiesCache.workspace === workspaceSlug && $propertiesCache.data != null
			? $propertiesCache.data
			: null;

	$: propertyName = (() => {
		if (!propertySlug) return '';
		const match = (properties ?? []).find((property) => slugify(property.name) === propertySlug);
		if (match?.name) return match.name;
		return propertySlug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
	})();

	$: issues = $issuesCache.data?.issues ?? [];
	$: propertyIssues = issues.filter((issue) => {
		if (!issue?.property) return false;
		return slugify(issue.property) === propertySlug;
	});

	$: sections = buildSectionsFromIssues(propertyIssues);
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

	$: isLoading = ($issuesCache.loading && issues.length === 0) || properties === null;

	const getIssueHref = (item) => {
		if (!item) return undefined;
		const slug = slugify(item.title);
		const readableId = item.readableId;
		if (!readableId) return undefined;
		return `${basePath}/issue/${readableId}/${slug}?from=property-issues`;
	};
</script>

<div>
	{#if isLoading}
		<div class="px-6 py-8 text-sm text-neutral-400">Loading issues...</div>
	{:else if expandedSections.length === 0}
		<div class="border-t border-neutral-200"></div>
		<div class="px-6 py-3 text-sm text-neutral-400">No issues yet.</div>
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
								href={getIssueHref(item)}
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
