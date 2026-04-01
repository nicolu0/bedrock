<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { fade, scale } from 'svelte/transition';
	import { getContext, onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { peopleCache } from '$lib/stores/peopleCache.js';
	import { propertiesCache } from '$lib/stores/propertiesCache.js';
	import SidebarButton from '$lib/components/SidebarButton.svelte';
	import { toggleChatPanel } from '$lib/stores/rightPanel.js';

	export let data;

	$: workspaceSlug = $page.params.workspace;
	$: role = $page.data?.role;
	$: canViewPeople = role === 'admin' || role === 'bedrock' || role === 'member';
	$: userName = $page.data?.userName;
	$: ownerPersonId = $page.data?.ownerPersonId;
	$: isOwnerRole = role === 'owner';
	$: ownerFallbackName = isOwnerRole ? (userName?.trim() ? userName.trim() : 'You') : '';
	$: ownerFallbackLabel =
		isOwnerRole && ownerFallbackName
			? ownerFallbackName === 'You'
				? 'You'
				: `${ownerFallbackName} (You)`
			: '';

	// data.properties from layout may be a streaming Promise; sync into shared store
	$: {
		const propData = data.properties;
		if (propData instanceof Promise) {
			propData.then((list) => {
				if (Array.isArray(list)) propertiesCache.set(list);
			});
		} else if (Array.isArray(propData)) {
			propertiesCache.set(propData);
		}
	}
	$: _properties = $propertiesCache ?? [];
	$: properties = _properties;

	$: owners = data.owners ?? [];

	let showNewPropertyModal = false;
	let newPropertyName = '';
	let newPropertyAddress = '';
	let newPropertyCity = '';
	let newPropertyState = '';
	let newPropertyPostalCode = '';
	let newPropertyCountry = '';
	let createPropertyError = '';
	let creating = false;
	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();
	let newPropertyOwnerId = '';
	let editingProperty = null;
	let editPropertyName = '';
	let editPropertyAddress = '';
	let editPropertyCity = '';
	let editPropertyState = '';
	let editPropertyPostalCode = '';
	let editPropertyCountry = '';
	let editPropertyOwnerId = '';
	let editPropertyOwnerName = '';
	let updatePropertyError = '';
	let updating = false;

	let suggestions = [];
	let showSuggestions = false;
	let addressInputEl;
	let addressTarget = 'new';
	let debounceTimer;
	let newOwnerOpen = false;
	let editOwnerOpen = false;
	let openRowMenu = null;
	let hoveredRow = null;

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

	const openNewPropertyModal = () => {
		showNewPropertyModal = true;
		createPropertyError = '';
		addressTarget = 'new';
		newPropertyOwnerId = isOwnerRole && ownerPersonId ? ownerPersonId : '';
		newOwnerOpen = false;
	};

	const closeNewPropertyModal = () => {
		showNewPropertyModal = false;
		newPropertyName = '';
		newPropertyAddress = '';
		newPropertyCity = '';
		newPropertyState = '';
		newPropertyPostalCode = '';
		newPropertyCountry = '';
		createPropertyError = '';
		newPropertyOwnerId = '';
		suggestions = [];
		showSuggestions = false;
		newOwnerOpen = false;
		document.activeElement?.blur();
	};

	const openEditPropertyModal = (property) => {
		editingProperty = property;
		editPropertyName = property?.name ?? '';
		editPropertyAddress = property?.address ?? '';
		editPropertyCity = property?.city ?? '';
		editPropertyState = property?.state ?? '';
		editPropertyPostalCode = property?.postal_code ?? '';
		editPropertyCountry = property?.country ?? '';
		editPropertyOwnerId = property?.owner_id ?? '';
		editPropertyOwnerName = isOwnerRole ? ownerFallbackName : '';
		updatePropertyError = '';
		addressTarget = 'edit';
		editOwnerOpen = false;
	};

	const closeEditPropertyModal = () => {
		editingProperty = null;
		editPropertyName = '';
		editPropertyAddress = '';
		editPropertyCity = '';
		editPropertyState = '';
		editPropertyPostalCode = '';
		editPropertyCountry = '';
		editPropertyOwnerId = '';
		editPropertyOwnerName = '';
		updatePropertyError = '';
		suggestions = [];
		showSuggestions = false;
		editOwnerOpen = false;
		document.activeElement?.blur();
	};

	function onKeydown(e) {
		if (e.key === 'Escape') {
			if (showSuggestions) {
				showSuggestions = false;
				suggestions = [];
				return;
			} else if (showNewPropertyModal) {
				closeNewPropertyModal();
			} else if (editingProperty) {
				closeEditPropertyModal();
			}
			newOwnerOpen = false;
			editOwnerOpen = false;
		}
	}

	async function onAddressInput(e) {
		const val = e.target.value.trim();
		clearTimeout(debounceTimer);
		if (val.length < 3) {
			suggestions = [];
			showSuggestions = false;
			return;
		}
		debounceTimer = setTimeout(async () => {
			const res = await fetch(`/api/places?input=${encodeURIComponent(val)}`);
			const result = await res.json();
			suggestions = Array.isArray(result) ? result : [];
			showSuggestions = suggestions.length > 0;
		}, 300);
	}

	async function selectSuggestion(s) {
		showSuggestions = false;
		suggestions = [];
		const res = await fetch(`/api/places?place_id=${s.place_id}`);
		const parts = await res.json();
		const street = [parts.streetNumber, parts.route].filter(Boolean).join(' ');
		if (addressTarget === 'edit') {
			editPropertyAddress = street;
			editPropertyCity = parts.city ?? '';
			editPropertyState = parts.state ?? '';
			editPropertyPostalCode = parts.postalCode ?? '';
			editPropertyCountry = parts.country ?? '';
			return;
		}
		newPropertyAddress = street;
		newPropertyCity = parts.city ?? '';
		newPropertyState = parts.state ?? '';
		newPropertyPostalCode = parts.postalCode ?? '';
		newPropertyCountry = parts.country ?? '';
	}

	function onWindowClick(e) {
		if (
			showSuggestions &&
			addressInputEl &&
			!addressInputEl.closest('.address-wrapper')?.contains(e.target)
		) {
			showSuggestions = false;
			suggestions = [];
		}
		if ((newOwnerOpen || editOwnerOpen) && !e.target.closest('.owner-dropdown')) {
			newOwnerOpen = false;
			editOwnerOpen = false;
		}
	}

	async function handleCreateProperty(e) {
		createPropertyError = '';
		creating = true;
		try {
			const res = await fetch('/api/properties', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace: workspaceSlug,
					name: newPropertyName.trim(),
					address: newPropertyAddress.trim(),
					city: newPropertyCity.trim(),
					state: newPropertyState.trim(),
					postalCode: newPropertyPostalCode.trim(),
					country: newPropertyCountry.trim(),
					ownerId: newPropertyOwnerId?.trim() ? newPropertyOwnerId.trim() : null
				})
			});
			const result = await res.json();
			if (!res.ok) {
				createPropertyError = result?.error ?? 'Unable to create property.';
				return;
			}
			closeNewPropertyModal();
			invalidate('app:properties');
		} catch {
			createPropertyError = 'Unable to create property.';
		} finally {
			creating = false;
		}
	}

	async function handleUpdateProperty(e) {
		updatePropertyError = '';
		if (!editingProperty?.id) return;

		const previous = _properties;
		const updated = {
			...editingProperty,
			name: editPropertyName.trim(),
			address: editPropertyAddress.trim(),
			city: editPropertyCity.trim(),
			state: editPropertyState.trim(),
			postal_code: editPropertyPostalCode.trim(),
			country: editPropertyCountry.trim(),
			owner_id: editPropertyOwnerId?.trim() ? editPropertyOwnerId.trim() : null
		};
		propertiesCache.set(_properties.map((p) => (p.id === editingProperty.id ? updated : p)));
		closeEditPropertyModal();

		try {
			const res = await fetch('/api/properties', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace: workspaceSlug,
					propertyId: updated.id,
					name: updated.name,
					address: updated.address,
					city: updated.city,
					state: updated.state,
					postalCode: updated.postal_code,
					country: updated.country,
					ownerId: updated.owner_id
				})
			});
			if (!res.ok) throw new Error('Failed to update property');
			invalidate('app:properties');
		} catch {
			propertiesCache.set(previous);
		}
	}

	async function deleteProperty(property) {
		if (!property?.id) return;
		openRowMenu = null;

		const previous = _properties;
		propertiesCache.set(_properties.filter((p) => p.id !== property.id));

		try {
			const res = await fetch('/api/properties', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: property.id, workspace: workspaceSlug })
			});
			if (!res.ok) throw new Error('Failed to delete property');
			invalidate('app:properties');
		} catch (error) {
			console.error(error);
			propertiesCache.set(previous);
		}
	}
	function getInitials(name) {
		if (!name) return '';
		const parts = name.trim().split(/\s+/);
		if (parts.length === 1) return parts[0][0].toUpperCase();
		return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
	}

	function getOwnerLabel(ownersList, ownerId, fallbackName) {
		if (!ownerId) return fallbackName?.trim() ? fallbackName : 'Not Selected';
		const match = (ownersList ?? []).find((owner) => owner.id === ownerId);
		return match?.name ?? (fallbackName?.trim() ? fallbackName : 'Not Selected');
	}
</script>

<svelte:window on:keydown={onKeydown} on:click={onWindowClick} />

<div class="flex h-full min-h-0 flex-col gap-2">
	<div class="flex items-center justify-between border-b border-neutral-200 py-2.5 pr-5 pl-6">
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
			<h1 class="text-sm font-normal text-neutral-700">Properties</h1>
		</div>
		<div class="flex items-center gap-2">
			<button
				on:click={openNewPropertyModal}
				type="button"
				class="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
			>
				+ New property
			</button>
			<SidebarButton onClick={toggleChatPanel} />
		</div>
	</div>
	<div class="flex items-center gap-2 border-b border-neutral-200 px-6 pb-2">
		<button
			class="rounded-md border border-neutral-200 bg-neutral-100/80 px-2 py-1 text-xs text-neutral-700"
		>
			All properties
		</button>
	</div>
	<div class="flex-1 overflow-y-auto">
		{#if properties.length}
			<div
				class="grid grid-cols-[1.4fr_0.6fr_0.6fr_0.4fr_2rem] gap-4 px-6 pb-2 text-xs text-neutral-500"
			>
				<div>Name</div>
				<div>Units</div>
				<div>Issues</div>
				<div>Owner</div>
				<div></div>
			</div>
			<div class="border-t border-neutral-200"></div>
			{#each properties as property}
				<div
					class="group grid cursor-pointer grid-cols-[1.4fr_0.6fr_0.6fr_0.4fr_2rem] gap-4 px-6 py-3 text-sm text-neutral-700 hover:bg-neutral-50"
					on:mouseenter={() => (hoveredRow = property.id)}
					on:mouseleave={() => (hoveredRow = null)}
					on:click={(e) => {
						e.currentTarget.blur();
						openRowMenu = null;
						openEditPropertyModal(property);
					}}
					role="button"
					tabindex="0"
					on:keydown={(e) => e.key === 'Enter' && openEditPropertyModal(property)}
				>
					<div class="truncate">{property.name}</div>
					<div class="text-neutral-500">{property.unit_count ?? 0}</div>
					<div class="text-neutral-500">{property.issue_count ?? 0}</div>
					<div class="flex items-center">
						<div
							class="flex h-6 w-6 items-center justify-center rounded-full border border-neutral-400 text-[10px] font-medium text-neutral-600"
						>
							{getInitials(getOwnerLabel(owners, property.owner_id, ownerFallbackName))}
						</div>
					</div>
					<div class="relative flex items-center justify-end">
						<button
							data-row-menu-toggle="true"
							class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${
								hoveredRow === property.id || openRowMenu === property.id
									? 'opacity-100'
									: 'opacity-0'
							} group-hover:opacity-100`}
							on:click|stopPropagation={() =>
								(openRowMenu = openRowMenu === property.id ? null : property.id)}
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
						{#if openRowMenu === property.id}
							<div
								data-row-menu="true"
								class="absolute top-full right-0 z-20 mt-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
								on:click|stopPropagation
							>
								<button
									class="flex w-full px-3 py-2 text-left text-rose-600 hover:bg-neutral-50"
									on:click={() => deleteProperty(property)}
									type="button"
								>
									Delete
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		{:else}
			<div class="px-6 py-3 text-sm text-neutral-400">No properties yet.</div>
		{/if}
	</div>
</div>

<svelte:body />
