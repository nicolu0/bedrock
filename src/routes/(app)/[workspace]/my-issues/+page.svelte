<script>
	// @ts-nocheck
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import { getContext } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import { seedIssueDetail } from '$lib/stores/issueDetailCache.js';
	import { applyIssueInsert, issuesCache, primeIssuesCache } from '$lib/stores/issuesCache.js';

	export let data;

	const tabs = ['All issues'];
	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();
	let showNewIssueModal = false;
	let newIssueTitle = '';
	let newIssueDescription = '';
	let newIssuePropertyId = '';
	let newIssueUnitId = '';
	let newIssueStatus = 'todo';
	let newIssueAssigneeId = '';
	let createIssueError = '';
	let creatingIssue = false;
	let filterOpen = false;
	let filterCategoryOpen = false;
	let filterValueOpen = false;
	let filterCategory = 'assignee';
	let filterValue = 'any';
	let filteredSections = [];

	$: _resolvedIssues =
		$issuesCache?.workspace === $page.params.workspace && $issuesCache?.data
			? $issuesCache.data
			: null;
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

	$: if (browser && _resolvedIssues?.sections) {
		for (const section of _resolvedIssues.sections) {
			for (const item of section.items ?? []) {
				seedIssueDetail(item, item.subIssues ?? []);
			}
		}
	}

	$: sections = _resolvedIssues?.sections ?? [];
	const normalizeStatusKey = (value) => {
		if (!value) return 'todo';
		const normalized = value
			.toString()
			.toLowerCase()
			.trim()
			.replace(/\s+/g, '_')
			.replace(/-/g, '_');
		if (normalized === 'in_progress') return 'in_progress';
		if (normalized === 'done' || normalized === 'completed' || normalized === 'complete')
			return 'done';
		if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
		return normalized;
	};

	$: expandedSections = sections.map((section) => {
		const rows = section.items.flatMap((item) => {
			const subRows = (item.subIssues ?? []).map((subIssue) => {
				const assigneeId = subIssue.assigneeId ?? subIssue.assignee_id ?? null;
				const propertyId =
					subIssue.propertyId ??
					subIssue.property_id ??
					item.propertyId ??
					item.property_id ??
					null;
				return {
					...subIssue,
					issueId: subIssue.issueId ?? item.issueId,
					parentTitle: subIssue.parentTitle ?? item.title,
					assignees: subIssue.assignees ?? item.assignees ?? 0,
					assigneeId,
					assigneeBadge: getAssigneeBadge(assigneeId, membersByUserId),
					property: subIssue.property ?? item.property,
					propertyId,
					property_id: propertyId,
					unit: subIssue.unit ?? item.unit,
					status: normalizeStatusKey(subIssue.status ?? item.status ?? section.id),
					isSubIssue: true
				};
			});
			const assigneeId = item.assigneeId ?? item.assignee_id ?? null;
			const propertyId = item.propertyId ?? item.property_id ?? null;
			return [
				{
					...item,
					assigneeId,
					assigneeBadge: getAssigneeBadge(assigneeId, membersByUserId),
					propertyId,
					property_id: propertyId,
					status: normalizeStatusKey(item.status ?? section.id),
					isSubIssue: item.isSubIssue ?? false
				},
				...subRows
			];
		});
		return { ...section, rows };
	});

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: currentUserId = $page.data?.userId ?? '';
	let _resolvedProperties = [];
	let _resolvedUnits = [];
	$: {
		const propsData = $page.data?.properties;
		if (propsData instanceof Promise) {
			propsData.then((list) => {
				_resolvedProperties = Array.isArray(list) ? list : [];
			});
		} else {
			_resolvedProperties = Array.isArray(propsData) ? propsData : [];
		}
	}
	$: {
		const unitsData = $page.data?.units;
		if (unitsData instanceof Promise) {
			unitsData.then((list) => {
				_resolvedUnits = Array.isArray(list) ? list : [];
			});
		} else {
			_resolvedUnits = Array.isArray(unitsData) ? unitsData : [];
		}
	}
	$: properties = _resolvedProperties;
	$: units = _resolvedUnits;
	$: propertiesById = properties.reduce((acc, property) => {
		if (!property?.id) return acc;
		acc[property.id] = property;
		return acc;
	}, {});
	$: unitsById = units.reduce((acc, unit) => {
		if (!unit?.id) return acc;
		acc[unit.id] = unit;
		return acc;
	}, {});
	$: availableUnits = newIssuePropertyId
		? units.filter((unit) => unit.property_id === newIssuePropertyId)
		: units;
	let _resolvedMembers = [];
	$: {
		if (data.members instanceof Promise) {
			data.members.then((m) => {
				_resolvedMembers = m ?? [];
			});
		} else {
			_resolvedMembers = data.members ?? [];
		}
	}
	$: membersByUserId = _resolvedMembers.reduce((acc, member) => {
		if (!member?.user_id) return acc;
		acc[member.user_id] = member;
		return acc;
	}, {});
	$: members = _resolvedMembers;
	const statusOptions = [
		{ value: 'todo', label: 'Todo' },
		{ value: 'in_progress', label: 'In Progress' },
		{ value: 'done', label: 'Done' }
	];
	const filterCategories = [
		{ value: 'assignee', label: 'Assignee' },
		{ value: 'status', label: 'Status' },
		{ value: 'building', label: 'Building' }
	];

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

	let filterValueOptions = [];
	$: {
		if (filterCategory === 'assignee') {
			const assigneeOptions = [...members]
				.filter((member) => {
					const role = (member?.role ?? '').toLowerCase();
					return Boolean(member?.user_id) && (role === 'admin' || role === 'member');
				})
				.map((member) => ({
					value: member.user_id,
					label: member.users?.name ?? member.name ?? 'Member'
				}))
				.sort((a, b) => a.label.localeCompare(b.label));
			filterValueOptions = [
				{ value: 'any', label: 'Any assignee' },
				{ value: 'unassigned', label: 'Unassigned' },
				...assigneeOptions
			].filter((option) => option.value);
		} else if (filterCategory === 'status') {
			filterValueOptions = [{ value: 'any', label: 'Any status' }, ...statusOptions];
		} else if (filterCategory === 'building') {
			filterValueOptions = [
				{ value: 'any', label: 'Any building' },
				...properties.map((property) => ({
					value: property.id,
					label: property.name
				}))
			].filter((option) => option.value);
		} else {
			filterValueOptions = [{ value: 'any', label: 'Any' }];
		}
	}
	$: selectedCategory =
		filterCategories.find((option) => option.value === filterCategory) ?? filterCategories[0];
	$: {
		if (!filterValueOptions.some((option) => option.value === filterValue)) {
			filterValue = filterValueOptions[0]?.value ?? 'any';
		}
	}
	$: selectedValue =
		filterValueOptions.find((option) => option.value === filterValue) ?? filterValueOptions[0];

	$: filteredSections = expandedSections
		.map((section) => {
			const rows = (section.rows ?? []).filter((row) => {
				if (filterCategory === 'assignee') {
					if (filterValue === 'any') return true;
					if (filterValue === 'unassigned') return !row.assigneeId;
					return String(row.assigneeId ?? '') === String(filterValue);
				}
				if (filterCategory === 'status') {
					if (filterValue === 'any') return true;
					return String(row.status ?? '') === String(filterValue);
				}
				if (filterCategory === 'building') {
					if (filterValue === 'any') return true;
					return String(row.propertyId ?? row.property_id ?? '') === String(filterValue);
				}
				return true;
			});
			return { ...section, rows, count: rows.length };
		})
		.filter((section) => section.rows.length > 0);
	$: hasActiveFilter = filterValue !== 'any';

	const openNewIssueModal = () => {
		showNewIssueModal = true;
		createIssueError = '';
		if (!newIssueStatus) newIssueStatus = 'todo';
		if (!newIssueAssigneeId && currentUserId) newIssueAssigneeId = currentUserId;
		if (!newIssuePropertyId && properties.length === 1) {
			newIssuePropertyId = properties[0]?.id ?? '';
		}
		if (!newIssueUnitId && availableUnits.length === 1) {
			newIssueUnitId = availableUnits[0]?.id ?? '';
		}
	};

	const closeNewIssueModal = () => {
		showNewIssueModal = false;
		newIssueTitle = '';
		newIssueDescription = '';
		newIssuePropertyId = '';
		newIssueUnitId = '';
		newIssueStatus = 'todo';
		newIssueAssigneeId = '';
		createIssueError = '';
		document.activeElement?.blur();
	};

	const closeFilterMenus = () => {
		filterOpen = false;
		filterCategoryOpen = false;
		filterValueOpen = false;
	};

	const handleFilterCategorySelect = (next) => {
		filterCategory = next;
		filterValue = 'any';
		filterCategoryOpen = false;
		filterValueOpen = false;
	};

	const handleFilterValueSelect = (next) => {
		filterValue = next;
		filterValueOpen = false;
	};

	const onWindowClick = () => {
		if (filterOpen || filterCategoryOpen || filterValueOpen) closeFilterMenus();
	};

	const handlePropertyChange = (event) => {
		newIssuePropertyId = event.target.value;
		if (!newIssuePropertyId) {
			newIssueUnitId = '';
			return;
		}
		const nextUnits = units.filter((unit) => unit.property_id === newIssuePropertyId);
		if (!nextUnits.some((unit) => unit.id === newIssueUnitId)) {
			newIssueUnitId = nextUnits[0]?.id ?? '';
		}
	};

	const handleCreateIssue = async () => {
		createIssueError = '';
		creatingIssue = true;
		try {
			const response = await fetch('/api/issues', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace: workspaceSlug,
					name: newIssueTitle.trim(),
					description: newIssueDescription.trim(),
					unitId: newIssueUnitId?.trim() ? newIssueUnitId.trim() : null,
					propertyId: newIssuePropertyId?.trim() ? newIssuePropertyId.trim() : null,
					status: newIssueStatus,
					assigneeId: newIssueAssigneeId?.trim() ? newIssueAssigneeId.trim() : null
				})
			});
			const result = await response.json();
			if (!response.ok) {
				createIssueError = result?.error ?? 'Unable to create issue.';
				return;
			}
			const selectedUnit = newIssueUnitId ? unitsById[newIssueUnitId] : null;
			const selectedProperty = selectedUnit
				? propertiesById[selectedUnit.property_id]
				: propertiesById[newIssuePropertyId];
			applyIssueInsert(result, {
				unitName: selectedUnit?.name ?? 'Unknown',
				propertyName: selectedProperty?.name ?? 'Unknown',
				parentTitle: ''
			});
			closeNewIssueModal();
		} catch {
			createIssueError = 'Unable to create issue.';
		} finally {
			creatingIssue = false;
		}
	};

	const onKeydown = (event) => {
		if (event.key === 'Escape' && showNewIssueModal) {
			closeNewIssueModal();
		}
	};
</script>

<svelte:window on:click={onWindowClick} on:keydown={onKeydown} />

<div>
	<div class="flex items-center justify-between border-b border-neutral-200 px-6 py-2.5">
		<div class="flex items-center gap-2">
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
		<button
			type="button"
			class="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
			on:click={openNewIssueModal}
		>
			+ New issue
		</button>
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
			<div class="relative" on:click|stopPropagation>
				<button
					class="inline-flex items-center gap-2 hover:text-neutral-800"
					type="button"
					aria-expanded={filterOpen}
					on:click|stopPropagation={() => {
						filterOpen = !filterOpen;
						filterCategoryOpen = false;
						filterValueOpen = false;
					}}
				>
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
				{#if filterOpen}
					<div
						class="absolute right-0 z-20 mt-2 w-72 origin-top-right rounded-md border border-neutral-200 bg-white py-2 text-xs text-neutral-700 shadow-lg"
						on:click|stopPropagation
					>
						<div class="flex items-center gap-2 px-3 py-2">
							<div class="relative flex-1">
								<button
									type="button"
									class="flex w-full items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-left text-xs text-neutral-700 transition hover:bg-neutral-50"
									on:click|stopPropagation={() => {
										filterCategoryOpen = !filterCategoryOpen;
										filterValueOpen = false;
									}}
								>
									<span class="truncate">{selectedCategory?.label ?? 'Category'}</span>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="12"
										height="12"
										fill="currentColor"
										viewBox="0 0 16 16"
									>
										<path
											d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
										/>
									</svg>
								</button>
								{#if filterCategoryOpen}
									<div
										class="absolute left-0 z-30 mt-2 w-full rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
										on:click|stopPropagation
									>
										{#each filterCategories as option}
											<button
												type="button"
												class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
													filterCategory === option.value ? 'bg-neutral-50' : ''
												}`}
												on:click|stopPropagation={() => handleFilterCategorySelect(option.value)}
											>
												<span>{option.label}</span>
												{#if filterCategory === option.value}
													<span class="text-[10px] text-neutral-400">Selected</span>
												{/if}
											</button>
										{/each}
									</div>
								{/if}
							</div>
							<div class="relative flex-1">
								<button
									type="button"
									disabled={!filterValueOptions.length}
									class={`flex w-full items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-left text-xs text-neutral-700 transition hover:bg-neutral-50 ${
										filterValueOptions.length ? '' : 'cursor-not-allowed opacity-60'
									}`}
									on:click|stopPropagation={() => {
										if (!filterValueOptions.length) return;
										filterValueOpen = !filterValueOpen;
										filterCategoryOpen = false;
									}}
								>
									<span class="truncate">{selectedValue?.label ?? 'Value'}</span>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="12"
										height="12"
										fill="currentColor"
										viewBox="0 0 16 16"
									>
										<path
											d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
										/>
									</svg>
								</button>
								{#if filterValueOpen}
									{#key filterCategory}
										<div
											class="absolute left-0 z-30 mt-2 w-full rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
											on:click|stopPropagation
										>
											{#each filterValueOptions as option}
												<button
													type="button"
													class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
														filterValue === option.value ? 'bg-neutral-50' : ''
													}`}
													on:click={() => handleFilterValueSelect(option.value)}
												>
													<span>{option.label}</span>
													{#if filterValue === option.value}
														<span class="text-[10px] text-neutral-400">Selected</span>
													{/if}
												</button>
											{/each}
										</div>
									{/key}
								{/if}
							</div>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>

	{#if _resolvedIssues === null}
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
	{:else if filteredSections.length === 0}
		<div class="px-6 py-8 text-sm text-neutral-400">
			{hasActiveFilter ? 'No issues match the current filter.' : 'No issues assigned to you.'}
		</div>
	{:else}
		<div class="divide-y divide-neutral-100">
			{#each filteredSections as section}
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

{#if showNewIssueModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/20"
		transition:fade={{ duration: 120 }}
		on:click={closeNewIssueModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.9 }}
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
		>
			<form on:submit|preventDefault={handleCreateIssue}>
				<div class="flex items-center justify-between">
					<div class="text-lg font-medium text-neutral-800">New issue</div>
					<button
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeNewIssueModal}
						type="button"
						aria-label="Close"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="24"
							height="24"
							fill="currentColor"
							viewBox="0 0 16 16"
						>
							<path
								d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"
							/>
						</svg>
					</button>
				</div>
				<div class="mt-5 flex flex-col gap-3">
					{#if createIssueError}
						<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">
							{createIssueError}
						</p>
					{/if}
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Issue title"
						name="name"
						bind:value={newIssueTitle}
						required
						type="text"
					/>
					<textarea
						class="min-h-[96px] rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Description (optional)"
						name="description"
						bind:value={newIssueDescription}
					></textarea>
					<div>
						<label class="text-xs text-neutral-500">Property</label>
						<select
							class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							bind:value={newIssuePropertyId}
							on:change={handlePropertyChange}
							required
							disabled={!properties.length}
						>
							<option value="" disabled>
								{properties.length ? 'Select a property' : 'No properties available'}
							</option>
							{#each properties as property}
								<option value={property.id}>{property.name}</option>
							{/each}
						</select>
					</div>
					<div>
						<label class="text-xs text-neutral-500">Unit</label>
						<select
							class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							bind:value={newIssueUnitId}
							disabled={!availableUnits.length}
						>
							<option value="" disabled>
								{availableUnits.length ? 'Select a unit' : 'No units available'}
							</option>
							{#each availableUnits as unit}
								<option value={unit.id}>{unit.name}</option>
							{/each}
						</select>
					</div>
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<label class="text-xs text-neutral-500">Status</label>
							<select
								class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
								bind:value={newIssueStatus}
								required
							>
								{#each statusOptions as option}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</div>
						<div>
							<label class="text-xs text-neutral-500">Assignee</label>
							<select
								class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
								bind:value={newIssueAssigneeId}
							>
								<option value="">Unassigned</option>
								{#each members as member}
									<option value={member.user_id}>
										{member.users?.name ?? member.name ?? 'Member'}
									</option>
								{/each}
							</select>
						</div>
					</div>
				</div>
				<div class="mt-5 flex items-center justify-end gap-2">
					<button
						class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeNewIssueModal}
						type="button"
					>
						Cancel
					</button>
					<button
						class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
						disabled={creatingIssue || !newIssueTitle.trim() || !newIssuePropertyId}
						type="submit"
					>
						{creatingIssue ? 'Creating...' : 'Create issue'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
