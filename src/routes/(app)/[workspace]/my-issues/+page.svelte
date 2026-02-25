<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	const tabs = ['Assigned', 'Subscribed', 'Activity'];
	const sections = [
		{
			id: 'in-progress',
			label: 'In Progress',
			count: 1,
			statusClass: 'border-amber-500 text-amber-600',
			items: [
				{
					id: 'ip-1',
					issueId: 'HUB-1',
					title: 'Click and scroll to trigger navigation',
					assignees: 1,
					property: 'Hub',
					unit: '701',
					subIssues: [
						{
							id: 'ip-1a',
							issueId: 'HUB-2',
							title: 'Another sub issue',
							parentTitle: 'Click and scroll to trigger navigation',
							property: 'Hub',
							unit: '701'
						},
						{
							id: 'ip-1b',
							issueId: 'HUB-3',
							title: 'Helloooo testing sub issuessss',
							parentTitle: 'Click and scroll to trigger navigation',
							property: 'Hub',
							unit: '701'
						}
					]
				}
			]
		},
		{
			id: 'todo',
			label: 'Todo',
			count: 3,
			statusClass: 'border-neutral-500 text-neutral-700',
			items: [
				{
					id: 'td-1',
					issueId: 'HUB-4',
					title: 'Clicking instagram icon navigates to byong instagram',
					assignees: 1,
					property: 'Hub',
					unit: '701'
				},
				{
					id: 'td-2',
					issueId: 'HUB-5',
					title: 'Navigation bar (name and instagram icon)',
					assignees: 1,
					property: 'Hub',
					unit: '701'
				},
				{
					id: 'td-3',
					issueId: 'HUB-6',
					title: 'Scrolling up animation to reveal home page',
					assignees: 1,
					property: 'Hub',
					unit: '701'
				}
			]
		},
		{
			id: 'backlog',
			label: 'Backlog',
			count: 5,
			statusClass: 'border-neutral-500 text-neutral-600 border-dashed',
			items: [
				{
					id: 'bl-1',
					issueId: 'HUB-7',
					title: 'Link to instagram posts?',
					assignees: 1,
					property: 'Hub',
					unit: '701'
				},
				{
					id: 'bl-2',
					issueId: 'HUB-8',
					title: 'Portrait page',
					assignees: 1,
					property: 'Hub',
					unit: '701'
				},
				{
					id: 'bl-3',
					issueId: 'HUB-9',
					title: 'Architecture page',
					assignees: 1,
					property: 'Hub',
					unit: '701'
				},
				{
					id: 'bl-4',
					issueId: 'HUB-10',
					title: 'Black and white page',
					assignees: 1,
					property: 'Hub',
					unit: '701'
				},
				{
					id: 'bl-5',
					issueId: 'HUB-11',
					title: 'Street page',
					assignees: 1,
					property: 'Hub',
					unit: '701'
				}
			]
		}
	];

	const expandedSections = sections.map((section) => {
		const rows = section.items.flatMap((item) => {
			const subRows = (item.subIssues ?? []).map((subIssue) => ({
				...subIssue,
				issueId: subIssue.issueId ?? item.issueId,
				parentTitle: subIssue.parentTitle ?? item.title,
				assignees: subIssue.assignees ?? item.assignees ?? 1,
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

	const slugify = (value) => {
		if (!value) return 'issue';
		return value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
	};

	const goToIssue = (issueId, title) => {
		const slug = slugify(title);
		goto(`${basePath}/issue/${issueId}/${slug}`);
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
						<button
							class="w-full px-6 py-2 text-left transition hover:bg-stone-50"
							on:click={() => goToIssue(item.issueId, item.title)}
							type="button"
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
						</button>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>
