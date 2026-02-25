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
	let createPropertyError = '';

	const openNewPropertyModal = () => {
		showNewPropertyModal = true;
		createPropertyError = '';
	};

	const closeNewPropertyModal = () => {
		showNewPropertyModal = false;
		newPropertyName = '';
		newPropertyAddress = '';
		createPropertyError = '';
	};

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
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between border-b border-neutral-100 px-6 pb-2">
		<h1 class="text-sm font-normal text-neutral-700">Properties</h1>
		<button
			on:click={openNewPropertyModal}
			type="button"
			class="text-xs text-neutral-600 transition hover:text-neutral-900"
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
								<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
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
	<div class="pointer-events-none fixed inset-0 z-50 flex items-start justify-center px-4 py-10">
		<div
			class="pointer-events-auto w-full max-w-3xl rounded-xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.9 }}
			on:click|stopPropagation
		>
			<form method="POST" action="?/createProperty" use:enhance={enhanceCreateProperty}>
				<div class="flex items-center justify-between">
					<div class="text-sm font-medium text-neutral-500">New property</div>
					<button
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
						on:click={closeNewPropertyModal}
						type="button"
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
				<div class="mt-6 space-y-6">
					<div>
						<label class="text-xs font-semibold tracking-[0.2em] text-neutral-400 uppercase"
							>Name</label
						>
						<input
							class="mt-3 w-full rounded-lg border border-neutral-200 px-4 py-3 text-base text-neutral-900 focus:border-neutral-400 focus:outline-none"
							placeholder="Property name"
							name="name"
							bind:value={newPropertyName}
							required
							type="text"
						/>
					</div>
					<div>
						<label class="text-xs font-semibold tracking-[0.2em] text-neutral-400 uppercase"
							>Full address</label
						>
						<textarea
							class="mt-3 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
							placeholder="Street, city, state, zip"
							name="address"
							bind:value={newPropertyAddress}
							rows="3"
						></textarea>
					</div>
					{#if createPropertyError}
						<div
							class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
						>
							{createPropertyError}
						</div>
					{/if}
				</div>
				<div class="mt-8 flex items-center justify-end gap-3">
					<button
						class="rounded-full px-4 py-2 text-sm font-medium text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700"
						on:click={closeNewPropertyModal}
						type="button"
					>
						Cancel
					</button>
					<button
						class={`rounded-full px-4 py-2 text-sm font-medium transition ${newPropertyName.trim() ? 'bg-neutral-900 text-white hover:bg-neutral-800' : 'bg-neutral-200 text-neutral-500'}`}
						disabled={!newPropertyName.trim()}
						type="submit"
					>
						Create property
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
