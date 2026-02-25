<script>
	// @ts-nocheck
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { fade, scale } from 'svelte/transition';

	export let data;
	$: propertiesPromise = data?.properties ?? Promise.resolve([]);

	let showNewPropertyModal = false;
	let newPropertyName = '';
	let newPropertyAddress = '';
	let newPropertyCity = '';
	let newPropertyState = '';
	let newPropertyPostalCode = '';
	let newPropertyCountry = '';
	let createPropertyError = '';

	let suggestions = [];
	let showSuggestions = false;
	let addressInputEl;
	let debounceTimer;

	const openNewPropertyModal = () => {
		showNewPropertyModal = true;
		createPropertyError = '';
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
		suggestions = [];
		showSuggestions = false;
		document.activeElement?.blur();
	};

	function onKeydown(e) {
		if (e.key === 'Escape') {
			if (showSuggestions) {
				showSuggestions = false;
				suggestions = [];
			} else if (showNewPropertyModal) {
				closeNewPropertyModal();
			}
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
		newPropertyAddress = [parts.streetNumber, parts.route].filter(Boolean).join(' ');
		newPropertyCity = parts.city ?? '';
		newPropertyState = parts.state ?? '';
		newPropertyPostalCode = parts.postalCode ?? '';
		newPropertyCountry = parts.country ?? '';
	}

	function onWindowClick(e) {
		if (showSuggestions && addressInputEl && !addressInputEl.closest('.address-wrapper')?.contains(e.target)) {
			showSuggestions = false;
			suggestions = [];
		}
	}

	const enhanceCreateProperty = () => {
		return async ({ result }) => {
			if (result?.type === 'success') {
				closeNewPropertyModal();
				await invalidateAll();
				return;
			}
			if (result?.type === 'failure') {
				createPropertyError = result.data?.error ?? 'Unable to create property.';
			}
		};
	};
	function getInitials(name) {
		if (!name) return '';
		const parts = name.trim().split(/\s+/);
		if (parts.length === 1) return parts[0][0].toUpperCase();
		return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
	}
</script>

<svelte:window on:keydown={onKeydown} on:click={onWindowClick} />

<div class="space-y-2">
	<div class="flex items-center justify-between border-b border-neutral-100 px-6 pb-2">
		<h1 class="text-sm font-normal text-neutral-700">Properties</h1>
		<button
			on:click={openNewPropertyModal}
			type="button"
			class="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
		>
			+ New property
		</button>
	</div>
	<div class="flex items-center gap-2 px-6 pb-2">
		<button
			class="rounded-md border border-neutral-200 bg-neutral-100/80 px-2 py-1 text-xs text-neutral-700"
		>
			All properties
		</button>
		<button class="rounded-md px-2 py-1 text-xs text-neutral-400">+ New view</button>
	</div>
	<div>
		<div
			class="grid grid-cols-[1.4fr_0.6fr_0.6fr_0.4fr] gap-4 px-6 py-2 text-[11px] text-neutral-400"
		>
			<div>Name</div>
			<div>Units</div>
			<div>Issues</div>
			<div>Owner</div>
		</div>
		<div class="border-t border-neutral-100"></div>
		<div class="divide-y divide-neutral-100">
			{#await propertiesPromise}
				<div class="px-6 py-3 text-xs text-neutral-400">Loading properties...</div>
			{:then properties}
				{#if properties?.length}
					{#each properties as property}
						<div
							class="grid grid-cols-[1.4fr_0.6fr_0.6fr_0.4fr] gap-4 px-6 py-3 text-sm text-neutral-700"
						>
							<div class="flex items-center gap-3">
								<div class="h-7 w-7 rounded-md bg-neutral-100"></div>
								<div class="truncate">{property.name}</div>
							</div>
							<div class="text-neutral-500">--</div>
							<div class="text-neutral-500">--</div>
							<div class="flex items-center">
								<div class="flex h-6 w-6 items-center justify-center rounded-full border border-neutral-400 text-[10px] font-medium text-neutral-600">
									{getInitials(property.owner?.name)}
								</div>
							</div>
						</div>
					{/each}
				{:else}
					<div class="px-6 py-3 text-sm text-neutral-400">No properties yet.</div>
				{/if}
			{:catch}
				<div class="px-6 py-3 text-sm text-neutral-400">Unable to load properties.</div>
			{/await}
		</div>
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
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
						on:click={closeNewPropertyModal}
						type="button"
						aria-label="Close"
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16">
							<path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708" />
						</svg>
					</button>
				</div>
				<div class="mt-5 flex flex-col gap-3">
					{#if createPropertyError}
						<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{createPropertyError}</p>
					{/if}
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Property name"
						name="name"
						bind:value={newPropertyName}
						required
						type="text"
					/>
					<div class="address-wrapper relative">
						<input
							class="w-full rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="Address"
							name="address"
							bind:value={newPropertyAddress}
							bind:this={addressInputEl}
							on:input={onAddressInput}
							type="text"
							autocomplete="off"
							required
						/>
						{#if showSuggestions}
							<ul class="absolute z-10 mt-1 w-full rounded-xl border border-stone-200 bg-white shadow-lg">
								{#each suggestions as s}
									<li>
										<button type="button" on:click={() => selectSuggestion(s)}
											class="w-full px-3.5 py-2.5 text-left text-sm text-neutral-700 hover:bg-neutral-50 first:rounded-t-xl last:rounded-b-xl">
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
						class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
						on:click={closeNewPropertyModal}
						type="button"
					>
						Cancel
					</button>
					<button
						class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
						disabled={!newPropertyName.trim() || !newPropertyAddress.trim() || !newPropertyCity.trim() || !newPropertyState.trim() || !newPropertyPostalCode.trim() || !newPropertyCountry.trim()}
						type="submit"
					>
						Create property
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
