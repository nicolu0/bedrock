<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { flip } from 'svelte/animate';
	import PeopleModal from '$lib/components/PeopleModal.svelte';
	import {
		peopleCache,
		primePeopleCache,
		removePersonFromCache,
		addPersonToCache,
		updatePersonInCache
	} from '$lib/stores/peopleCache.js';

	export let data;

	let editingPerson = null;
	let openRowMenu = null;
	let hoveredRow = null;

	$: workspaceSlug = $page.params.workspace;

	$: {
		if (data.people instanceof Promise) {
			data.people.then((d) => {
				if (browser && Array.isArray(d)) primePeopleCache(workspaceSlug, d);
			});
		} else if (Array.isArray(data.people)) {
			if (browser) primePeopleCache(workspaceSlug, data.people);
		}
	}

	$: resolvedPeople =
		$peopleCache.workspace === workspaceSlug && $peopleCache.data != null
			? $peopleCache.data
			: Array.isArray(data.people)
				? data.people
				: null;
	$: vendors = Array.isArray(resolvedPeople)
		? resolvedPeople.filter((person) => person.role === 'vendor')
		: [];

	const getTradeName = (vendor) => vendor?.trade?.toString().trim() || 'Unknown trade';

	let orderedVendors = [];
	let isDragging = false;
	let draggedVendorId = null;
	let draggedTrade = null;
	let suppressClick = false;
	let dragPreviewEl = null;
	let dropIndicator = null;
	let listContainer = null;

	$: if (!isDragging) {
		orderedVendors = [...(vendors ?? [])].sort((a, b) => {
			const tradeA = getTradeName(a);
			const tradeB = getTradeName(b);
			if (tradeA !== tradeB) return tradeA.localeCompare(tradeB);
			const prefA = Number.isFinite(a?.preference_index) ? a.preference_index : 999999;
			const prefB = Number.isFinite(b?.preference_index) ? b.preference_index : 999999;
			if (prefA !== prefB) return prefA - prefB;
			return (a.name ?? '').localeCompare(b.name ?? '');
		});
	}

	const groupRowsByTrade = (rows) => {
		const groups = new Map();
		for (const row of rows ?? []) {
			const name = getTradeName(row);
			if (!groups.has(name)) groups.set(name, []);
			groups.get(name).push(row);
		}
		return [...groups.entries()]
			.map(([name, items]) => ({ name, items }))
			.sort((a, b) => a.name.localeCompare(b.name));
	};

	let collapsedTradeGroups = {};
	const getTradeGroupKey = (tradeName) => `${tradeName ?? 'Unknown trade'}`;
	const isTradeGroupCollapsed = (tradeName) =>
		Boolean(collapsedTradeGroups[getTradeGroupKey(tradeName)]);
	const toggleTradeGroup = (tradeName) => {
		const key = getTradeGroupKey(tradeName);
		collapsedTradeGroups = {
			...collapsedTradeGroups,
			[key]: !collapsedTradeGroups[key]
		};
	};

	$: tradeGroups = groupRowsByTrade(orderedVendors);

	const handleDragStart = (event, vendor) => {
		suppressClick = true;
		isDragging = true;
		draggedVendorId = vendor.id;
		draggedTrade = getTradeName(vendor);
		if (event?.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', vendor.id ?? '');
			const row = event.currentTarget;
			if (row) {
				dragPreviewEl = row.cloneNode(true);
				dragPreviewEl.style.position = 'absolute';
				dragPreviewEl.style.top = '-9999px';
				dragPreviewEl.style.left = '-9999px';
				dragPreviewEl.style.width = `${row.offsetWidth}px`;
				dragPreviewEl.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.12)';
				dragPreviewEl.style.background = '#fff';
				dragPreviewEl.style.borderRadius = '8px';
				dragPreviewEl.style.opacity = '0.95';
				document.body.appendChild(dragPreviewEl);
				event.dataTransfer.setDragImage(dragPreviewEl, 24, 16);
			}
		}
	};

	const handleDragOver = (event, groupName, targetId) => {
		if (!draggedVendorId || !groupName || groupName !== draggedTrade) return;
		if (draggedVendorId === targetId) return;
		const target = event.currentTarget;
		const containerRect = listContainer?.getBoundingClientRect();
		const targetRect = target?.getBoundingClientRect();
		if (!targetRect || !containerRect) return;
		const offset = event.clientY - targetRect.top;
		const position = offset > targetRect.height / 2 ? 'after' : 'before';
		const top =
			(position === 'after' ? targetRect.bottom : targetRect.top) -
			containerRect.top +
			(listContainer?.scrollTop ?? 0);
		dropIndicator = {
			top,
			position,
			groupName,
			targetId
		};
	};

	const handleDrop = (groupName, targetId, positionOverride) => {
		if (!draggedVendorId || !groupName || groupName !== draggedTrade) return;
		const position = positionOverride ?? dropIndicator?.position ?? 'after';
		const groupItems = orderedVendors.filter((vendor) => getTradeName(vendor) === groupName);
		const ids = groupItems.map((vendor) => vendor.id);
		const fromIndex = ids.indexOf(draggedVendorId);
		const targetIndex = ids.indexOf(targetId);
		if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return;
		let insertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
		if (fromIndex < insertIndex) insertIndex -= 1;
		const nextGroupItems = [...groupItems];
		const [moved] = nextGroupItems.splice(fromIndex, 1);
		nextGroupItems.splice(insertIndex, 0, moved);
		let groupIndex = 0;
		const next = orderedVendors.map((vendor) => {
			if (getTradeName(vendor) !== groupName) return vendor;
			const replacement = nextGroupItems[groupIndex];
			groupIndex += 1;
			return replacement;
		});
		orderedVendors = [...next];
	};

	const handleListDrop = () => {
		if (!dropIndicator?.groupName || !dropIndicator?.targetId) return;
		handleDrop(dropIndicator.groupName, dropIndicator.targetId, dropIndicator.position);
	};

	const persistVendorOrder = async (groupName) => {
		if (!groupName) return;
		const groupItems = orderedVendors.filter((vendor) => getTradeName(vendor) === groupName);
		const updates = groupItems.map((vendor, index) => ({
			id: vendor.id,
			preference_index: index + 1
		}));
		updates.forEach((update) => {
			const target = groupItems.find((vendor) => vendor.id === update.id);
			if (!target) return;
			updatePersonInCache({ ...target, preference_index: update.preference_index });
		});
		try {
			await fetch('/api/vendors/order', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace: workspaceSlug,
					updates
				})
			});
		} catch (error) {
			console.error(error);
		}
	};

	const handleDragEnd = async () => {
		const trade = draggedTrade;
		isDragging = false;
		draggedVendorId = null;
		draggedTrade = null;
		dropIndicator = null;
		if (dragPreviewEl) {
			dragPreviewEl.remove();
			dragPreviewEl = null;
		}
		await persistVendorOrder(trade);
		setTimeout(() => {
			suppressClick = false;
		}, 0);
	};

	const formatRole = (role) => {
		if (!role) return 'Member';
		return role[0].toUpperCase() + role.slice(1);
	};

	const roleBadgeClass = (role) => {
		switch (role) {
			case 'bedrock':
				return 'bg-stone-700 text-stone-300';
			case 'admin':
				return 'bg-rose-50 text-rose-600';
			case 'owner':
				return 'bg-green-50 text-green-700';
			case 'vendor':
				return 'bg-yellow-50 text-yellow-700';
			case 'member':
			default:
				return 'bg-sky-50 text-sky-600';
		}
	};

	onMount(() => {
		const handleDocumentClick = (event) => {
			if (!openRowMenu) return;
			const path = event.composedPath?.() ?? [];
			const isMenuClick = path.some(
				(node) => node?.dataset?.rowMenu === 'true' || node?.dataset?.rowMenuToggle === 'true'
			);
			if (!isMenuClick) openRowMenu = null;
		};

		document.addEventListener('click', handleDocumentClick);
		return () => document.removeEventListener('click', handleDocumentClick);
	});

	async function deletePerson(person) {
		if (!person?.id) return;
		openRowMenu = null;
		removePersonFromCache(person.id);
		try {
			const res = await fetch('/api/people', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: person.id, workspace: workspaceSlug })
			});
			if (!res.ok) throw new Error('Failed to delete person');
		} catch (error) {
			addPersonToCache(person, workspaceSlug);
			console.error(error);
		}
	}
</script>

<div class="space-y-2">
	<div>
		{#if resolvedPeople === null}
			<div>
				{#each { length: 4 } as _}
					<div class="grid grid-cols-[0.6fr_1.6fr_1fr_2fr_2rem] gap-4 px-6 py-3">
						<div class="skeleton h-5 w-16 rounded-sm"></div>
						<div class="skeleton h-4 w-32"></div>
						<div></div>
						<div class="skeleton h-4 w-40"></div>
						<div></div>
					</div>
				{/each}
			</div>
		{:else if vendors.length}
			<div
				class="grid grid-cols-[0.6fr_1.6fr_1fr_2fr_2rem] gap-4 px-6 py-2 text-xs text-neutral-500"
			>
				<div>Role</div>
				<div>Name</div>
				<div>Trade</div>
				<div>Email</div>
				<div></div>
			</div>
			<div class="border-t border-neutral-200"></div>
			<div
				class="relative"
				bind:this={listContainer}
				on:dragover|preventDefault
				on:drop|preventDefault={handleListDrop}
			>
				{#if dropIndicator && isDragging}
					<div
						class="pointer-events-none absolute right-6 left-6 z-10"
						style={`top: ${dropIndicator.top}px;`}
					>
						<div class="h-0.5 w-full rounded-full bg-sky-500"></div>
					</div>
				{/if}
				{#each tradeGroups as group}
					<button
						type="button"
						class="group flex w-full items-center gap-3 px-6.5 py-2.5 text-left text-xs text-neutral-400 transition hover:text-neutral-900"
						on:click={() => toggleTradeGroup(group.name)}
					>
						<span class="font-normal text-inherit">{group.name}</span>
						<div
							class="flex-1 border-t border-neutral-200 transition group-hover:border-neutral-800"
						></div>
					</button>
					{#if !isTradeGroupCollapsed(group.name)}
						<div class="mb-2">
							{#each group.items as vendor (vendor.id)}
								<div
									class="group grid cursor-grab cursor-pointer grid-cols-[0.6fr_1.6fr_1fr_2fr_2rem] gap-4 px-6 py-3 text-sm text-neutral-700 hover:bg-neutral-50 active:cursor-grabbing"
									on:mouseenter={() => (hoveredRow = vendor.id)}
									on:mouseleave={() => (hoveredRow = null)}
									on:dragover|preventDefault={(event) =>
										handleDragOver(event, group.name, vendor.id)}
									on:drop|preventDefault={() => handleDrop(group.name, vendor.id)}
									on:click={(e) => {
										if (suppressClick) return;
										e.currentTarget.blur();
										openRowMenu = null;
										editingPerson = vendor;
									}}
									role="button"
									tabindex="0"
									on:keydown={(e) => e.key === 'Enter' && (editingPerson = vendor)}
									draggable="true"
									on:dragstart={(event) => handleDragStart(event, vendor)}
									on:dragend={handleDragEnd}
									animate:flip={{ duration: 160 }}
								>
									<div class="flex items-center gap-2">
										<span
											class={`rounded-sm px-2 py-1 text-xs font-medium ${roleBadgeClass(vendor.role)}`}
										>
											{formatRole(vendor.role)}
										</span>
									</div>
									<div class="flex items-center gap-1.5 truncate">
										<span class="truncate">{vendor.name}</span>
										{#if vendor.user_id && data.currentUserId && vendor.user_id === data.currentUserId}
											<span class="text-xs text-neutral-400">(You)</span>
										{/if}
									</div>
									<div class="truncate text-neutral-500">{vendor.trade ?? '—'}</div>
									<div class="truncate text-neutral-500">{vendor.email ?? '—'}</div>
									<div class="relative flex items-center">
										<button
											data-row-menu-toggle="true"
											class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredRow === vendor.id || openRowMenu === vendor.id ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100`}
											on:click|stopPropagation={() =>
												(openRowMenu = openRowMenu === vendor.id ? null : vendor.id)}
											type="button"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="16"
												height="16"
												fill="currentColor"
												class="bi bi-three-dots"
												viewBox="0 0 16 16"
											>
												<path
													d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3"
												/>
											</svg>
										</button>
										{#if openRowMenu === vendor.id}
											<div
												data-row-menu="true"
												class="absolute top-full right-0 z-20 mt-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
												on:click|stopPropagation
											>
												<button
													class="flex w-full px-3 py-2 text-left text-rose-600 hover:bg-neutral-50"
													on:click={() => deletePerson(vendor)}
													type="button"
												>
													Delete
												</button>
											</div>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				{/each}
			</div>
		{:else}
			<div class="px-6 py-3 text-sm text-neutral-400">No vendors yet.</div>
		{/if}
	</div>
</div>

{#if editingPerson}
	<PeopleModal person={editingPerson} on:close={() => (editingPerson = null)} />
{/if}

<style>
	.tooltip-target .delayed-tooltip {
		opacity: 0;
		pointer-events: none;
	}

	.tooltip-target:hover .delayed-tooltip {
		opacity: 1;
	}

	.tooltip-target:focus-within .delayed-tooltip {
		opacity: 0;
	}

	.tooltip-target:focus-within:hover .delayed-tooltip {
		opacity: 1;
	}

	@media (hover: none) {
		.tooltip-target .delayed-tooltip {
			display: none;
		}
	}
</style>
