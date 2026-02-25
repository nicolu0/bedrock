<script>
	// @ts-nocheck
	import { page } from '$app/stores';

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
</script>

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
