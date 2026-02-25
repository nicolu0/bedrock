<script>
	// @ts-nocheck
	export let data;
	$: propertiesPromise = data?.properties ?? Promise.resolve([]);
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between border-b border-neutral-100 px-6 pb-2">
		<h1 class="text-sm font-normal text-neutral-700">Properties</h1>
		<button type="button" class="text-xs text-neutral-600 transition hover:text-neutral-900">
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
