<script>
	// @ts-nocheck
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { fade, scale } from 'svelte/transition';
	import { getContext } from 'svelte';
	import {
		propertiesCache,
		addPropertyToCache,
		updatePropertyInCache,
		replacePropertyInCache,
		removePropertyFromCache
	} from '$lib/stores/propertiesCache.js';
	import { peopleCache, ensurePeopleCache } from '$lib/stores/peopleCache.js';

	$: workspaceSlug = $page.params.workspace;

	$: if (browser && workspaceSlug) {
		ensurePeopleCache(workspaceSlug);
	}

	$: properties =
		$propertiesCache.workspace === workspaceSlug && $propertiesCache.data != null
			? $propertiesCache.data
			: null;

	let owners = null;
	$: owners =
		$peopleCache.workspace === workspaceSlug && Array.isArray($peopleCache.data)
			? $peopleCache.data.filter((person) => person?.role === 'owner')
			: null;

	let showNewPropertyModal = false;
	let newPropertyName = '';
	let newPropertyAddress = '';
	let newPropertyCity = '';
	let newPropertyState = '';
	let newPropertyPostalCode = '';
	let newPropertyCountry = '';
	let createPropertyError = '';
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

	let suggestions = [];
	let showSuggestions = false;
	let addressInputEl;
	let addressTarget = 'new';
	let debounceTimer;
	let newOwnerOpen = false;
	let editOwnerOpen = false;

	const openNewPropertyModal = () => {
		showNewPropertyModal = true;
		createPropertyError = '';
		addressTarget = 'new';
		newPropertyOwnerId = '';
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
		editPropertyOwnerName = '';
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
			const data = await res.json();
			suggestions = Array.isArray(data) ? data : [];
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

	const enhanceCreateProperty = ({ formData }) => {
		createPropertyError = '';
		const tempId = `temp-${Date.now()}`;
		const optimistic = {
			id: tempId,
			name: newPropertyName.trim(),
			address: newPropertyAddress.trim(),
			city: newPropertyCity.trim(),
			state: newPropertyState.trim(),
			postal_code: newPropertyPostalCode.trim(),
			country: newPropertyCountry.trim(),
			owner_id: newPropertyOwnerId?.trim() ? newPropertyOwnerId.trim() : null
		};
		addPropertyToCache(optimistic);
		return async ({ result }) => {
			if (result?.type === 'success') {
				const created = result.data?.property;
				if (created?.id) {
					replacePropertyInCache(tempId, { ...optimistic, ...created });
				}
				closeNewPropertyModal();
				return;
			}
			removePropertyFromCache(tempId);
			createPropertyError = result?.data?.error ?? 'Unable to create property.';
		};
	};
	const enhanceUpdateProperty = ({ formData }) => {
		updatePropertyError = '';
		if (!editingProperty?.id) {
			return async ({ result }) => {
				if (result?.type === 'failure') {
					updatePropertyError = result.data?.error ?? 'Unable to update property.';
				}
			};
		}
		const previous = { ...editingProperty };
		const optimistic = {
			...editingProperty,
			name: editPropertyName.trim(),
			address: editPropertyAddress.trim(),
			city: editPropertyCity.trim(),
			state: editPropertyState.trim(),
			postal_code: editPropertyPostalCode.trim(),
			country: editPropertyCountry.trim(),
			owner_id: editPropertyOwnerId?.trim() ? editPropertyOwnerId.trim() : null
		};
		updatePropertyInCache(optimistic);
		closeEditPropertyModal();
		return async ({ result }) => {
			if (result?.type === 'success') {
				const updated = result.data?.property;
				if (updated?.id) {
					updatePropertyInCache({ ...optimistic, ...updated });
				}
				return;
			}
			if (previous?.id) {
				updatePropertyInCache(previous);
			}
			openEditPropertyModal(previous);
			updatePropertyError = result?.data?.error ?? 'Unable to update property.';
		};
	};
	function getInitials(name) {
		if (!name) return '';
		const parts = name.trim().split(/\s+/);
		if (parts.length === 1) return parts[0][0].toUpperCase();
		return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
	}
	function getOwnerLabel(owners, ownerId, fallbackName) {
		if (!ownerId) return fallbackName?.trim() ? fallbackName : 'Not Selected';
		const match = (owners ?? []).find((owner) => owner.id === ownerId);
		return match?.name ?? (fallbackName?.trim() ? fallbackName : 'Not Selected');
	}
</script>

<svelte:window on:keydown={onKeydown} on:click={onWindowClick} />

<div class="space-y-2">
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
			<h1 class="text-sm font-normal text-neutral-700">Properties</h1>
		</div>
		<button
			on:click={openNewPropertyModal}
			type="button"
			class="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
		>
			+ New property
		</button>
	</div>
	<div class="flex items-center gap-2 border-b border-neutral-200 px-6 pb-2">
		<button
			class="rounded-md border border-neutral-200 bg-neutral-100/80 px-2 py-1 text-xs text-neutral-700"
		>
			All properties
		</button>
		<button class="rounded-md px-2 py-1 text-xs text-neutral-400">+ New view</button>
	</div>
	<div>
		{#if properties !== null}
			{#if properties?.length}
				<div
					class="grid grid-cols-[1.4fr_0.6fr_0.6fr_0.4fr] gap-4 px-6 pb-2 text-xs text-neutral-500"
				>
					<div>Name</div>
					<div>Units</div>
					<div>Issues</div>
					<div>Owner</div>
				</div>
				<div class="border-t border-neutral-200"></div>
				{#each properties as property}
					<div
						class="grid cursor-pointer grid-cols-[1.4fr_0.6fr_0.6fr_0.4fr] gap-4 px-6 py-3 text-sm text-neutral-700 hover:bg-neutral-50"
						on:click={(e) => {
							e.currentTarget.blur();
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
								{getInitials(getOwnerLabel(owners, property.owner_id, property.owner?.name))}
							</div>
						</div>
					</div>
				{/each}
			{:else}
				<div class="px-6 py-3 text-sm text-neutral-400">No properties yet.</div>
			{/if}
		{:else}
			<div
				class="grid grid-cols-[1.4fr_0.6fr_0.6fr_0.4fr] gap-4 px-6 pb-2 text-xs text-neutral-500"
			>
				<div>Name</div>
				<div>Units</div>
				<div>Issues</div>
				<div>Owner</div>
			</div>
			<div class="border-t border-neutral-200"></div>
			<div class="px-6 py-3 text-xs text-neutral-400">Loading properties...</div>
		{/if}
	</div>
</div>

{#if showNewPropertyModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/20"
		transition:fade={{ duration: 120 }}
		on:click={closeNewPropertyModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.9 }}
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
		>
			<form method="POST" action="?/createProperty" use:enhance={enhanceCreateProperty}>
				<div class="flex items-center justify-between">
					<div class="text-lg font-medium text-neutral-800">New property</div>
					<button
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeNewPropertyModal}
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
					{#if createPropertyError}
						<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">
							{createPropertyError}
						</p>
					{/if}
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Property name"
						name="name"
						bind:value={newPropertyName}
						required
						type="text"
					/>
					{#if owners !== null}
						<div class="owner-dropdown relative">
							<label class="text-xs text-neutral-500">Owner</label>
							<button
								type="button"
								class="mt-1 flex w-full items-center justify-between rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 transition hover:bg-neutral-50"
								on:click|stopPropagation={() => {
									newOwnerOpen = !newOwnerOpen;
									editOwnerOpen = false;
								}}
								aria-expanded={newOwnerOpen}
							>
								<span>{getOwnerLabel(owners, newPropertyOwnerId)}</span>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									fill="currentColor"
									class={`text-neutral-400 transition ${newOwnerOpen ? 'rotate-180' : ''}`}
									viewBox="0 0 16 16"
								>
									<path
										d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
									/>
								</svg>
							</button>
							<input type="hidden" name="ownerId" value={newPropertyOwnerId} />
							{#if newOwnerOpen}
								<div
									class="absolute z-10 mt-2 w-full rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
								>
									<button
										class={`flex w-full items-center justify-between px-3.5 py-2 text-left text-sm ${
											!newPropertyOwnerId ? 'bg-neutral-50 text-neutral-900' : 'hover:bg-neutral-50'
										}`}
										type="button"
										on:click={() => {
											newPropertyOwnerId = '';
											newOwnerOpen = false;
										}}
									>
										<span>Not Selected</span>
										{#if !newPropertyOwnerId}
											<span class="text-xs text-neutral-400">Selected</span>
										{/if}
									</button>
									{#each owners as owner}
										<button
											class={`flex w-full items-center justify-between px-3.5 py-2 text-left text-sm ${
												owner.id === newPropertyOwnerId
													? 'bg-neutral-50 text-neutral-900'
													: 'hover:bg-neutral-50'
											}`}
											type="button"
											on:click={() => {
												newPropertyOwnerId = owner.id ?? '';
												newOwnerOpen = false;
											}}
										>
											<span>{owner.name ?? 'Unnamed owner'}</span>
											{#if owner.id === newPropertyOwnerId}
												<span class="text-xs text-neutral-400">Selected</span>
											{/if}
										</button>
									{/each}
								</div>
							{/if}
						</div>
					{:else if $peopleCache.error}
						<div
							class="rounded-xl border border-stone-200 bg-neutral-50 px-3.5 py-2.5 text-sm text-neutral-400"
						>
							Unable to load owners.
						</div>
					{:else}
						<div
							class="rounded-xl border border-stone-200 bg-neutral-50 px-3.5 py-2.5 text-sm text-neutral-400"
						>
							Loading owners...
						</div>
					{/if}
					<div class="mt-2 text-xs text-neutral-500">Address</div>
					<div class="address-wrapper relative">
						<input
							class="w-full rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="Address"
							name="address"
							bind:value={newPropertyAddress}
							bind:this={addressInputEl}
							on:input={onAddressInput}
							on:focus={() => (addressTarget = 'new')}
							type="text"
							autocomplete="off"
							required
						/>
						{#if showSuggestions && addressTarget === 'new'}
							<ul
								class="absolute z-10 mt-1 w-full rounded-xl border border-stone-200 bg-white shadow-lg"
							>
								{#each suggestions as s}
									<li>
										<button
											type="button"
											on:click={() => selectSuggestion(s)}
											class="w-full px-3.5 py-2.5 text-left text-sm text-neutral-700 first:rounded-t-xl last:rounded-b-xl hover:bg-neutral-50"
										>
											{s.description}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="City"
						name="city"
						bind:value={newPropertyCity}
						type="text"
						required
					/>
					<div class="flex gap-2">
						<input
							class="flex-1 rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="State / Province"
							name="state"
							bind:value={newPropertyState}
							type="text"
							required
						/>
						<input
							class="w-32 rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="Postal code"
							name="postalCode"
							bind:value={newPropertyPostalCode}
							type="text"
							required
						/>
					</div>
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Country"
						name="country"
						bind:value={newPropertyCountry}
						type="text"
						required
					/>
				</div>
				<div class="mt-5 flex items-center justify-end gap-2">
					<button
						class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeNewPropertyModal}
						type="button"
					>
						Cancel
					</button>
					<button
						class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
						disabled={!newPropertyName.trim() ||
							!newPropertyAddress.trim() ||
							!newPropertyCity.trim() ||
							!newPropertyState.trim() ||
							!newPropertyPostalCode.trim() ||
							!newPropertyCountry.trim()}
						type="submit"
					>
						Create property
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

{#if editingProperty}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/20"
		transition:fade={{ duration: 120 }}
		on:click={closeEditPropertyModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.9 }}
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
		>
			<form method="POST" action="?/updateProperty" use:enhance={enhanceUpdateProperty}>
				<div class="flex items-center justify-between">
					<div class="text-lg font-medium text-neutral-800">Edit property</div>
					<button
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeEditPropertyModal}
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
					{#if updatePropertyError}
						<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">
							{updatePropertyError}
						</p>
					{/if}
					<input type="hidden" name="propertyId" value={editingProperty?.id} />
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Property name"
						name="name"
						bind:value={editPropertyName}
						required
						type="text"
					/>
					{#if owners !== null}
						<div class="owner-dropdown relative">
							<label class="text-xs text-neutral-500">Owner</label>
							<button
								type="button"
								class="mt-1 flex w-full items-center justify-between rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 transition hover:bg-neutral-50"
								on:click|stopPropagation={() => {
									editOwnerOpen = !editOwnerOpen;
									newOwnerOpen = false;
								}}
								aria-expanded={editOwnerOpen}
							>
								<span>{getOwnerLabel(owners, editPropertyOwnerId, editPropertyOwnerName)}</span>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									fill="currentColor"
									class={`text-neutral-400 transition ${editOwnerOpen ? 'rotate-180' : ''}`}
									viewBox="0 0 16 16"
								>
									<path
										d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
									/>
								</svg>
							</button>
							<input type="hidden" name="ownerId" value={editPropertyOwnerId} />
							{#if editOwnerOpen}
								<div
									class="absolute z-10 mt-2 w-full rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
								>
									<button
										class={`flex w-full items-center justify-between px-3.5 py-2 text-left text-sm ${
											!editPropertyOwnerId
												? 'bg-neutral-50 text-neutral-900'
												: 'hover:bg-neutral-50'
										}`}
										type="button"
										on:click={() => {
											editPropertyOwnerId = '';
											editOwnerOpen = false;
										}}
									>
										<span>Not Selected</span>
										{#if !editPropertyOwnerId}
											<span class="text-xs text-neutral-400">Selected</span>
										{/if}
									</button>
									{#each owners as owner}
										<button
											class={`flex w-full items-center justify-between px-3.5 py-2 text-left text-sm ${
												owner.id === editPropertyOwnerId
													? 'bg-neutral-50 text-neutral-900'
													: 'hover:bg-neutral-50'
											}`}
											type="button"
											on:click={() => {
												editPropertyOwnerId = owner.id ?? '';
												editOwnerOpen = false;
											}}
										>
											<span>{owner.name ?? 'Unnamed owner'}</span>
											{#if owner.id === editPropertyOwnerId}
												<span class="text-xs text-neutral-400">Selected</span>
											{/if}
										</button>
									{/each}
								</div>
							{/if}
						</div>
					{:else if $peopleCache.error}
						<div
							class="rounded-xl border border-stone-200 bg-neutral-50 px-3.5 py-2.5 text-sm text-neutral-400"
						>
							Unable to load owners.
						</div>
					{:else}
						<div
							class="rounded-xl border border-stone-200 bg-neutral-50 px-3.5 py-2.5 text-sm text-neutral-400"
						>
							Loading owners...
						</div>
					{/if}
					<div class="mt-2 text-xs text-neutral-500">Address</div>
					<div class="address-wrapper relative">
						<input
							class="w-full rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="Address"
							name="address"
							bind:value={editPropertyAddress}
							bind:this={addressInputEl}
							on:input={onAddressInput}
							on:focus={() => (addressTarget = 'edit')}
							type="text"
							autocomplete="off"
							required
						/>
						{#if showSuggestions && addressTarget === 'edit'}
							<ul
								class="absolute z-10 mt-1 w-full rounded-xl border border-stone-200 bg-white shadow-lg"
							>
								{#each suggestions as s}
									<li>
										<button
											type="button"
											on:click={() => selectSuggestion(s)}
											class="w-full px-3.5 py-2.5 text-left text-sm text-neutral-700 first:rounded-t-xl last:rounded-b-xl hover:bg-neutral-50"
										>
											{s.description}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="City"
						name="city"
						bind:value={editPropertyCity}
						type="text"
						required
					/>
					<div class="flex gap-2">
						<input
							class="flex-1 rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="State / Province"
							name="state"
							bind:value={editPropertyState}
							type="text"
							required
						/>
						<input
							class="w-32 rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="Postal code"
							name="postalCode"
							bind:value={editPropertyPostalCode}
							type="text"
							required
						/>
					</div>
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Country"
						name="country"
						bind:value={editPropertyCountry}
						type="text"
						required
					/>
				</div>
				<div class="mt-5 flex items-center justify-end gap-2">
					<button
						class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeEditPropertyModal}
						type="button"
					>
						Cancel
					</button>
					<button
						class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
						disabled={!editPropertyName.trim() ||
							!editPropertyAddress.trim() ||
							!editPropertyCity.trim() ||
							!editPropertyState.trim() ||
							!editPropertyPostalCode.trim() ||
							!editPropertyCountry.trim()}
						type="submit"
					>
						Save changes
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
