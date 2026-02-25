<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { getContext } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { fade, scale } from 'svelte/transition';

	export let data;
	$: propertiesPromise = data?.properties ?? Promise.resolve([]);
	$: unitsPromise = data?.units ?? Promise.resolve([]);
	$: propertySlug = $page.params.property;
	$: propertyUnitsPromise = (async () => {
		const properties = await propertiesPromise;
		const units = await unitsPromise;
		const match = (properties ?? []).find((property) => {
			const slug = property.name
				.toLowerCase()
				.trim()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)+/g, '');
			return slug === propertySlug;
		});
		if (!match?.id) return [];
		return (units ?? []).filter((unit) => unit.property_id === match.id);
	})();

	const showNewUnitModal = getContext('showNewUnitModal');

	let newUnitName = '';
	let newUnitTenantName = '';
	let newUnitVacant = false;
	let createUnitError = '';

	const closeModal = () => {
		$showNewUnitModal = false;
		newUnitName = '';
		newUnitTenantName = '';
		newUnitVacant = false;
		createUnitError = '';
		document.activeElement?.blur();
	};

	function onKeydown(e) {
		if (e.key === 'Escape' && $showNewUnitModal) closeModal();
	}

	const enhanceCreateUnit = () => {
		return async ({ result }) => {
			if (result?.type === 'success') {
				closeModal();
				await invalidateAll();
				return;
			}
			if (result?.type === 'failure') {
				createUnitError = result.data?.error ?? 'Unable to create unit.';
			}
		};
	};
</script>

<svelte:window on:keydown={onKeydown} />

<div class="space-y-2">
	<div>
		{#await propertyUnitsPromise}
			<div class="border-t border-neutral-100"></div>
			<div class="px-6 py-3 text-xs text-neutral-400">Loading units...</div>
		{:then units}
			{#if units?.length}
				<div
					class="grid grid-cols-[1.6fr_0.6fr_0.4fr] gap-4 px-6 py-2 text-[11px] text-neutral-400"
				>
					<div>Name</div>
					<div>Issues</div>
					<div>Tenant</div>
				</div>
				<div class="border-t border-neutral-100"></div>
				<div class="divide-y divide-neutral-100">
					{#each units as unit}
						<div
							class="grid grid-cols-[1.6fr_0.6fr_0.4fr] gap-4 px-6 py-3 text-sm text-neutral-700"
						>
							<div class="flex items-center gap-3">
								<div class="h-7 w-7 rounded-md bg-neutral-100"></div>
								<div class="truncate">{unit.name}</div>
							</div>
							<div class="text-neutral-500">--</div>
							<div class="flex items-center">
								<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<div class="border-t border-neutral-100"></div>
				<div class="px-6 py-3 text-sm text-neutral-400">No units yet.</div>
			{/if}
		{:catch}
			<div class="border-t border-neutral-100"></div>
			<div class="px-6 py-3 text-sm text-neutral-400">Unable to load units.</div>
		{/await}
	</div>
</div>

{#if $showNewUnitModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/20"
		transition:fade={{ duration: 120 }}
		on:click={closeModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.9 }}
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
		>
			<form method="POST" action="?/createUnit" use:enhance={enhanceCreateUnit}>
				<div class="flex items-center justify-between">
					<div class="text-lg font-medium text-neutral-800">New unit</div>
					<button
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
						on:click={closeModal}
						type="button"
						aria-label="Close"
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16">
							<path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708" />
						</svg>
					</button>
				</div>
				<div class="mt-5 flex flex-col gap-3">
					{#if createUnitError}
						<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{createUnitError}</p>
					{/if}
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Unit number"
						name="name"
						bind:value={newUnitName}
						required
						type="text"
					/>
					<div class="flex flex-col gap-1.5">
						<input
							class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400"
							placeholder="Tenant name"
							name="tenantName"
							bind:value={newUnitTenantName}
							disabled={newUnitVacant}
							type="text"
						/>
						<label class="flex cursor-pointer items-center gap-2 px-1">
							<input
								type="checkbox"
								class="h-3.5 w-3.5 cursor-pointer rounded accent-stone-700"
								bind:checked={newUnitVacant}
								on:change={() => { if (newUnitVacant) newUnitTenantName = ''; }}
							/>
							<span class="text-xs text-neutral-500">Unit currently vacant</span>
						</label>
					</div>
					<input type="hidden" name="vacant" value={newUnitVacant} />
				</div>
				<div class="mt-5 flex items-center justify-end gap-2">
					<button
						class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
						on:click={closeModal}
						type="button"
					>
						Cancel
					</button>
					<button
						class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
						disabled={!newUnitName.trim()}
						type="submit"
					>
						Create unit
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
