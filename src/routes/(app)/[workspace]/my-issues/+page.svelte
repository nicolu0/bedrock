<script>
	// @ts-nocheck
	const tabs = ['Assigned', 'Created', 'Subscribed', 'Activity'];
	const sections = [
		{
			id: 'in-progress',
			label: 'In Progress',
			count: 1,
			statusClass: 'border-amber-400 text-amber-500',
			items: [
				{
					id: 'ip-1',
					title: 'Click and scroll to trigger navigation',
					assignees: 1,
					subIssues: ['Another sub issue', 'Helloooo testing sub issuessss']
				}
			]
		},
		{
			id: 'todo',
			label: 'Todo',
			count: 3,
			statusClass: 'border-neutral-300 text-neutral-500',
			items: [
				{ id: 'td-1', title: 'Clicking instagram icon navigates to byong instagram', assignees: 1 },
				{ id: 'td-2', title: 'Navigation bar (name and instagram icon)', assignees: 1 },
				{ id: 'td-3', title: 'Scrolling up animation to reveal home page', assignees: 1 }
			]
		},
		{
			id: 'backlog',
			label: 'Backlog',
			count: 5,
			statusClass: 'border-neutral-300 text-neutral-400 border-dashed',
			items: [
				{ id: 'bl-1', title: 'Link to instagram posts?', assignees: 1 },
				{ id: 'bl-2', title: 'Portrait page', assignees: 1 },
				{ id: 'bl-3', title: 'Architecture page', assignees: 1 },
				{ id: 'bl-4', title: 'Black and white page', assignees: 1 },
				{ id: 'bl-5', title: 'Street page', assignees: 1 }
			]
		}
	];
</script>

<div>
	<div class="border-b border-neutral-100 px-6 pb-2">
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
		{#each sections as section}
			<div>
				<div class="flex items-center justify-between px-6 py-2 text-sm text-neutral-600 bg-stone-100">
					<div class="flex items-center gap-3">
						<span class={`h-4 w-4 rounded-full border ${section.statusClass}`}></span>
						<span class="text-sm text-neutral-700">{section.label}</span>
						<span class="text-xs text-neutral-400">{section.count}</span>
					</div>
					<button class="text-lg text-neutral-400 hover:text-neutral-700" type="button"> + </button>
				</div>
				<div class="divide-y divide-neutral-100">
					{#each section.items as item}
						<div class="px-6 py-3">
							<div class="flex items-center justify-between gap-4">
								<div class="flex items-center gap-3">
									<span class="h-4 w-4 rounded-full border border-neutral-300"></span>
									<span class="text-sm text-neutral-800">{item.title}</span>
								</div>
								<div class="flex items-center gap-2">
									{#each Array(item.assignees) as _}
										<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
									{/each}
								</div>
							</div>
							{#if item.subIssues}
								<div class="mt-3 ml-5 space-y-2 border-l border-neutral-200 pl-5">
									{#each item.subIssues as subIssue}
										<div class="flex items-center gap-3 text-xs text-neutral-500">
											<span class="h-3 w-3 rounded-full border border-neutral-300"></span>
											<span>{subIssue}</span>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>
