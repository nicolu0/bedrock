<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { vendorsCache, primeVendorsCache, addVendorToCache, updateVendorInCache } from '$lib/stores/vendorsCache.js';
	import VendorModal from '$lib/components/VendorModal.svelte';

	export let data;

	let showAddModal = false;
	let editingVendor = null;

	$: workspaceSlug = $page.params.workspace;

	$: vendors =
		$vendorsCache.workspace === workspaceSlug && $vendorsCache.data != null
			? $vendorsCache.data
			: null;

	$: if (browser && data.vendors) {
		data.vendors.then((v) => primeVendorsCache(workspaceSlug, v));
	}

	function onSaved(e) {
		const vendor = e.detail;
		if (editingVendor) {
			updateVendorInCache(vendor);
			editingVendor = null;
		} else {
			addVendorToCache(vendor);
			showAddModal = false;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center border-b border-neutral-100 px-6 py-3">
		<h1 class="text-sm font-normal text-neutral-700">People</h1>
	</div>

	<div class="px-6">
		<!-- Vendors subsection -->
		<div class="flex items-center justify-between mb-3">
			<span class="text-sm font-medium text-neutral-700">Vendors</span>
			<button
				class="rounded-md px-2 py-1 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
				on:click={(e) => { e.currentTarget.blur(); showAddModal = true; }}
			>
				+ Add vendor
			</button>
		</div>

		<div class="overflow-hidden rounded-xl border border-neutral-200 bg-white">
			<div
				class="grid gap-4 border-b border-neutral-200 bg-neutral-50 px-5 py-3 text-xs font-semibold tracking-[0.12em] text-neutral-500 uppercase"
				style="grid-template-columns: 2fr 1fr 1.5fr"
			>
				<div>Name</div>
				<div>Trade</div>
				<div>Email</div>
			</div>

			{#if vendors !== null}
				{#each vendors as vendor}
					<div
						class="grid gap-4 border-t border-neutral-100 px-5 py-3 text-sm hover:bg-neutral-50 cursor-pointer"
						style="grid-template-columns: 2fr 1fr 1.5fr"
						on:click={(e) => { e.currentTarget.blur(); editingVendor = vendor; }}
						role="button"
						tabindex="0"
						on:keydown={(e) => e.key === 'Enter' && (editingVendor = vendor)}
					>
						<div class="text-neutral-800 truncate">{vendor.name}</div>
						<div class="text-neutral-600 truncate">{vendor.trade ?? '—'}</div>
						<div class="text-neutral-500 truncate">{vendor.email}</div>
					</div>
				{:else}
					<div class="px-5 py-4 text-sm text-neutral-500">No vendors yet.</div>
				{/each}
			{:else}
				<div class="divide-y divide-neutral-100">
					{#each Array(3) as _, i}
						<div
							class="grid gap-4 border-t border-neutral-100 px-5 py-3"
							style="grid-template-columns: 2fr 1fr 1.5fr"
						>
							<div class="shimmer h-4 rounded" style="width: {i % 2 === 0 ? '8rem' : '6rem'}"></div>
							<div class="shimmer h-4 rounded w-16"></div>
							<div class="shimmer h-4 rounded" style="width: {i % 3 === 0 ? '10rem' : '7rem'}"></div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

{#if showAddModal}
	<VendorModal on:saved={onSaved} on:close={() => (showAddModal = false)} />
{/if}
{#if editingVendor}
	<VendorModal vendor={editingVendor} on:saved={onSaved} on:close={() => (editingVendor = null)} />
{/if}

<style>
	@keyframes shimmer {
		0% { background-position: -200% 0; }
		100% { background-position: 200% 0; }
	}
	.shimmer {
		background: linear-gradient(90deg, #f5f5f4 25%, #e8e5e3 50%, #f5f5f4 75%);
		background-size: 200% 100%;
		animation: shimmer 1.6s ease-in-out infinite;
	}
</style>
