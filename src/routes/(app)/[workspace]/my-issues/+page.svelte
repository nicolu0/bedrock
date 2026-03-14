<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';

	export let data;

	const tabs = ['All issues', 'Subscribed', 'Activity'];
	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();

	let _resolvedIssues = null;
	$: {
		if (data.issuesData instanceof Promise) {
			data.issuesData.then((d) => { _resolvedIssues = d; });
		} else if (data.issuesData) {
			_resolvedIssues = data.issuesData;
		}
	}

	$: sections = _resolvedIssues?.sections ?? [];
	$: expandedSections = sections.map((section) => {
		const rows = section.items.flatMap((item) => {
			const subRows = (item.subIssues ?? []).map((subIssue) => {
				const assigneeId = subIssue.assigneeId ?? subIssue.assignee_id ?? null;
				return {
					...subIssue,
					issueId: subIssue.issueId ?? item.issueId,
					parentTitle: subIssue.parentTitle ?? item.title,
					assignees: subIssue.assignees ?? item.assignees ?? 0,
					assigneeId,
					assigneeBadge: getAssigneeBadge(assigneeId, membersByUserId),
					property: subIssue.property ?? item.property,
					unit: subIssue.unit ?? item.unit,
					isSubIssue: true
				};
			});
			const assigneeId = item.assigneeId ?? item.assignee_id ?? null;
			return [
				{
					...item,
					assigneeId,
					assigneeBadge: getAssigneeBadge(assigneeId, membersByUserId),
					isSubIssue: item.isSubIssue ?? false
				},
				...subRows
			];
		});
		return { ...section, rows };
	});

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	let _resolvedMembers = [];
	$: {
		if (data.members instanceof Promise) {
			data.members.then((m) => { _resolvedMembers = m ?? []; });
		} else {
			_resolvedMembers = data.members ?? [];
		}
	}
	$: membersByUserId = _resolvedMembers.reduce((acc, member) => {
		if (!member?.user_id) return acc;
		acc[member.user_id] = member;
		return acc;
	}, {});

	const slugify = (value) => {
		if (!value) return 'issue';
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
		return `${basePath}/issue/${readableId}/${slug}?from=my-issues`;
	};

	const avatarPalette = [
		'bg-amber-200',
		'bg-blue-200',
		'bg-emerald-200',
		'bg-rose-200',
		'bg-indigo-200',
		'bg-teal-200',
		'bg-orange-200',
		'bg-sky-200'
	];

	const getAvatarColor = (seed) => {
		if (!seed) return 'bg-neutral-200';
		const value = seed.toString();
		let hash = 0;
		for (let i = 0; i < value.length; i += 1) {
			hash = (hash * 31 + value.charCodeAt(i)) % avatarPalette.length;
		}
		return avatarPalette[hash] ?? 'bg-neutral-200';
	};

	const getAssigneeBadge = (assigneeId, membersMap) => {
		const member = assigneeId ? membersMap[assigneeId] : null;
		const name = member?.users?.name ?? member?.name ?? 'Assigned';
		const initial = (name ?? 'U').toString().trim().charAt(0).toUpperCase() || 'U';
		const color = getAvatarColor(assigneeId ?? name);
		if (!assigneeId) return null;
		return { name, initial, color };
	};
</script>

<div>
	<div class="flex items-center gap-2 border-b border-neutral-200 px-6 py-3">
		<button
			type="button"
			aria-label="Open sidebar"
			class="rounded-md p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800 lg:hidden"
			on:click={openSidebar}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="12"
				height="12"
				fill="currentColor"
				class="bi bi-layout-sidebar"
				viewBox="0 0 16 16"
			>
				<path
					d="M0 3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm5-1v12h9a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zM4 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h2z"
				/>
			</svg>
		</button>
		<h1 class="text-sm font-normal text-neutral-700">My issues</h1>
	</div>
	<div class="flex items-center justify-between px-6 py-2">
		<div class="flex items-center gap-2">
			{#each tabs as tab}
				<button
					class={`rounded-md border px-2.5 py-1 text-xs transition ${
						tab === 'All issues'
							? 'border-neutral-200 bg-neutral-100 text-neutral-700'
							: 'border-neutral-200 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700'
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

	{#if _resolvedIssues === null}
		<div class="divide-y divide-neutral-100">
			{#each { length: 4 } as _}
				<div class="flex items-center gap-3 px-6 py-2">
					<div class="skeleton h-3 w-3 rounded-full flex-shrink-0"></div>
					<div class="skeleton h-4 w-2/5"></div>
					<div class="ml-auto skeleton h-5 w-28 rounded-full"></div>
					<div class="skeleton h-5 w-5 rounded-full"></div>
				</div>
			{/each}
		</div>
	{:else if sections.length === 0}
		<div class="px-6 py-8 text-sm text-neutral-400">No issues assigned to you.</div>
	{:else}
		<div class="divide-y divide-neutral-100">
			{#each expandedSections as section}
				<div>
					<div
						class="flex items-center justify-between border-y border-neutral-200 bg-stone-50 px-6 py-2 text-sm text-neutral-600"
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
											<span class="px-2 py-0.5">{item.property}</span>
											<span class="border-l border-neutral-200 px-2 py-0.5">{item.unit}</span>
										</div>
										{#if item.assigneeBadge}
											<div
												class={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-neutral-700 ${item.assigneeBadge.color}`}
												aria-label={item.assigneeBadge.name}
												title={item.assigneeBadge.name}
											>
												{item.assigneeBadge.initial}
											</div>
										{:else}
											<div
												class="flex h-5 w-5 items-center justify-center rounded-full text-neutral-300"
												aria-label="Unassigned"
												title="Unassigned"
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="16"
													height="16"
													fill="currentColor"
													class="bi bi-person-circle"
													viewBox="0 0 16 16"
												>
													<path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0" />
													<path
														fill-rule="evenodd"
														d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1"
													/>
												</svg>
											</div>
										{/if}
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
