<script>
	// @ts-nocheck
	import { getContext, onMount } from 'svelte';
	import { AsYouType } from 'libphonenumber-js';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { fade, scale } from 'svelte/transition';

	export let data;

	$: propertyUnits = data.propertyUnits ?? [];

	const showNewUnitModal = getContext('showNewUnitModal');

	let newUnitName = '';
	let newUnitTenantName = '';
	let newUnitTenantEmail = '';
	let newUnitTenantPhone = '';
	let createUnitError = '';
	let editingUnit = null;
	let editUnitName = '';
	let editUnitTenantName = '';
	let editUnitTenantEmail = '';
	let editUnitTenantPhone = '';
	let editUnitTenantId = '';
	let updateUnitError = '';
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

	const closeModal = () => {
		$showNewUnitModal = false;
		newUnitName = '';
		newUnitTenantName = '';
		newUnitTenantEmail = '';
		newUnitTenantPhone = '';
		createUnitError = '';
		document.activeElement?.blur();
	};

	const openEditUnitModal = (unit) => {
		editingUnit = unit;
		editUnitName = unit?.name ?? '';
		editUnitTenantName = unit?.tenant?.name ?? '';
		editUnitTenantEmail = unit?.tenant?.email ?? '';
		editUnitTenantPhone = unit?.tenant?.phone ?? '';
		editUnitTenantId = unit?.tenant?.id ?? '';
		updateUnitError = '';
	};

	const closeEditUnitModal = () => {
		editingUnit = null;
		editUnitName = '';
		editUnitTenantName = '';
		editUnitTenantEmail = '';
		editUnitTenantPhone = '';
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

	async function deleteUnit(unit) {
		if (!unit?.id) return;
		openRowMenu = null;
		try {
			const formData = new FormData();
			formData.set('unitId', unit.id);
			const res = await fetch('?/deleteUnit', {
				method: 'POST',
				body: formData
			});
			if (!res.ok) {
				throw new Error('Failed to delete unit');
			}
			await invalidateAll();
		} catch (error) {
			console.error(error);
		}
	}
	function getInitials(name) {
		if (!name) return '';
		const parts = name.trim().split(/\s+/);
		if (parts.length === 1) return parts[0][0].toUpperCase();
		return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
	}

	function phoneInput(e, setter) {
		const raw = e.target.value;
		let digits = raw.replace(/\D/g, '');
		if (digits.startsWith('1')) digits = digits.slice(1);
		digits = digits.slice(0, 10);
		const formatted = new AsYouType('US').input(digits);
		e.target.value = formatted;
		setter(formatted);
	}
</script>

<svelte:window on:keydown={onKeydown} />

<div class="space-y-2">
	<div>
		{#if propertyUnits.length}
			<div
				class="grid grid-cols-[1.6fr_0.6fr_0.4fr_2rem] gap-4 border-t border-neutral-200 px-6 py-2 text-xs text-neutral-500"
			>
				<div>Name</div>
				<div>Issues</div>
				<div>Tenant</div>
				<div></div>
			</div>
			<div class="border-t border-neutral-200"></div>
			<div>
				{#each propertyUnits as unit}
					<div
						class="group grid cursor-pointer grid-cols-[1.6fr_0.6fr_0.4fr_2rem] gap-4 px-6 py-3 text-sm text-neutral-700 hover:bg-neutral-50"
						on:mouseenter={() => (hoveredRow = unit.id)}
						on:mouseleave={() => (hoveredRow = null)}
						on:click={(e) => {
							e.currentTarget.blur();
							openRowMenu = null;
							openEditUnitModal(unit);
						}}
						role="button"
						tabindex="0"
						on:keydown={(e) => e.key === 'Enter' && openEditUnitModal(unit)}
					>
						<div class="truncate">{unit.name}</div>
						<div class="text-neutral-500">--</div>
						<div class="flex items-center">
							<div
								class="flex h-6 w-6 items-center justify-center rounded-full border border-neutral-400 text-[10px] font-medium text-neutral-600"
							>
								{getInitials(unit?.tenant?.name)}
							</div>
						</div>
						<div class="relative flex items-center justify-end">
							<button
								data-row-menu-toggle="true"
								class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${
									hoveredRow === unit.id || openRowMenu === unit.id ? 'opacity-100' : 'opacity-0'
								} group-hover:opacity-100`}
								on:click|stopPropagation={() =>
									(openRowMenu = openRowMenu === unit.id ? null : unit.id)}
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
							{#if openRowMenu === unit.id}
								<div
									data-row-menu="true"
									class="absolute top-full right-0 z-20 mt-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
									on:click|stopPropagation
								>
									<button
										class="flex w-full px-3 py-2 text-left text-rose-600 hover:bg-neutral-50"
										on:click={() => deleteUnit(unit)}
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
		{:else}
			<div class="border-t border-neutral-200"></div>
			<div class="px-6 py-3 text-sm text-neutral-400">No units yet.</div>
		{/if}
	</div>
</div>

<svelte:body />
