<script>
	// @ts-nocheck
	import { getContext } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { fade, scale } from 'svelte/transition';

	export let data;

	$: propertyUnits = data.propertyUnits ?? [];

	const showNewUnitModal = getContext('showNewUnitModal');

	let newUnitName = '';
	let newUnitTenantName = '';
	let newUnitTenantEmail = '';
	let createUnitError = '';
	let editingUnit = null;
	let editUnitName = '';
	let editUnitTenantName = '';
	let editUnitTenantEmail = '';
	let editUnitTenantId = '';
	let updateUnitError = '';

	const closeModal = () => {
		$showNewUnitModal = false;
		newUnitName = '';
		newUnitTenantName = '';
		newUnitTenantEmail = '';
		createUnitError = '';
		document.activeElement?.blur();
	};

	const openEditUnitModal = (unit) => {
		editingUnit = unit;
		editUnitName = unit?.name ?? '';
		editUnitTenantName = unit?.tenant?.name ?? '';
		editUnitTenantEmail = unit?.tenant?.email ?? '';
		editUnitTenantId = unit?.tenant?.id ?? '';
		updateUnitError = '';
	};

	const closeEditUnitModal = () => {
		editingUnit = null;
		editUnitName = '';
		editUnitTenantName = '';
		editUnitTenantEmail = '';
		editUnitTenantId = '';
		updateUnitError = '';
		document.activeElement?.blur();
	};

	function onKeydown(e) {
		if (e.key === 'Escape') {
			if ($showNewUnitModal) closeModal();
			if (editingUnit) closeEditUnitModal();
		}
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

	const enhanceUpdateUnit = () => {
		return async ({ result }) => {
			if (result?.type === 'success') {
				closeEditUnitModal();
				await invalidateAll();
				return;
			}
			if (result?.type === 'failure') {
				updateUnitError = result.data?.error ?? 'Unable to update unit.';
			}
		};
	};
</script>

<svelte:window on:keydown={onKeydown} />

<div class="space-y-2">
	<div>
		{#if propertyUnits.length}
			<div
				class="grid grid-cols-[1.6fr_0.6fr_0.4fr] gap-4 border-t border-neutral-200 px-6 py-2 text-xs text-neutral-500"
			>
				<div>Name</div>
				<div>Issues</div>
				<div>Tenant</div>
			</div>
			<div class="border-t border-neutral-200"></div>
			<div>
				{#each propertyUnits as unit}
					<div
						class="grid cursor-pointer grid-cols-[1.6fr_0.6fr_0.4fr] gap-4 px-6 py-3 text-sm text-neutral-700 hover:bg-neutral-50"
						on:click={(e) => {
							e.currentTarget.blur();
							openEditUnitModal(unit);
						}}
						role="button"
						tabindex="0"
						on:keydown={(e) => e.key === 'Enter' && openEditUnitModal(unit)}
					>
						<div class="truncate">{unit.name}</div>
						<div class="text-neutral-500">--</div>
						<div class="flex items-center">
							<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="border-t border-neutral-200"></div>
			<div class="px-6 py-3 text-sm text-neutral-400">No units yet.</div>
		{/if}
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
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeModal}
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
					<div class="mt-2 text-sm text-neutral-500">Primary Tenant (leave blank if vacant)</div>
					<div class="flex flex-col gap-1.5">
						<input
							class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="Name"
							name="tenantName"
							bind:value={newUnitTenantName}
							type="text"
						/>
						<input
							class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="Email"
							name="tenantEmail"
							bind:value={newUnitTenantEmail}
							type="email"
						/>
					</div>
				</div>
				<div class="mt-5 flex items-center justify-end gap-2">
					<button
						class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeModal}
						type="button"
					>
						Cancel
					</button>
					<button
						class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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

{#if editingUnit}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/20"
		transition:fade={{ duration: 120 }}
		on:click={closeEditUnitModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.9 }}
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
		>
			<form method="POST" action="?/updateUnit" use:enhance={enhanceUpdateUnit}>
				<div class="flex items-center justify-between">
					<div class="text-lg font-medium text-neutral-800">Edit unit</div>
					<button
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeEditUnitModal}
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
					{#if updateUnitError}
						<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{updateUnitError}</p>
					{/if}
					<input type="hidden" name="unitId" value={editingUnit?.id} />
					<input type="hidden" name="tenantId" value={editUnitTenantId} />
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Unit number"
						name="name"
						bind:value={editUnitName}
						required
						type="text"
					/>
					<div class="mt-2 text-sm text-neutral-500">Primary Tenant (leave blank if vacant)</div>
					<div class="flex flex-col gap-1.5">
						<input
							class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="Name"
							name="tenantName"
							bind:value={editUnitTenantName}
							type="text"
						/>
						<input
							class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							placeholder="Email"
							name="tenantEmail"
							bind:value={editUnitTenantEmail}
							type="email"
						/>
					</div>
				</div>
				<div class="mt-5 flex items-center justify-end gap-2">
					<button
						class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeEditUnitModal}
						type="button"
					>
						Cancel
					</button>
					<button
						class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
						disabled={!editUnitName.trim()}
						type="submit"
					>
						Save changes
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
