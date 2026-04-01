<script>
	// @ts-nocheck
	import { page } from '$app/stores';

	export let property;

	const slugify = (value) => {
		if (!value) return 'property';
		const base = value
			.toString()
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
		return base || 'property';
	};

	$: propertyHref = property?.slug
		? `/${$page.params.workspace}/properties/${property.slug}`
		: property?.name
			? `/${$page.params.workspace}/properties/${slugify(property.name)}`
			: '#';

	let hoverTooltipVisible = false;
	let hoverTooltipX = 0;
	let hoverTooltipY = 0;
</script>

<a
	href={propertyHref}
	class="block w-full px-4 py-2 text-left transition hover:bg-stone-50"
	data-sveltekit-preload-data="hover"
	on:mouseenter={(event) => {
		hoverTooltipVisible = true;
		const rect = event.currentTarget.getBoundingClientRect();
		hoverTooltipX = event.clientX + 12;
		hoverTooltipY = rect.bottom + 8;
	}}
	on:mousemove={(event) => {
		hoverTooltipX = event.clientX + 12;
	}}
	on:mouseleave={() => {
		hoverTooltipVisible = false;
	}}
>
	<div class="flex items-center justify-between gap-4">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<div class="relative">
				<span class="-m-1 flex items-center justify-center rounded-md p-1 text-neutral-400">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="14"
						height="14"
						fill="currentColor"
						viewBox="0 0 16 16"
					>
						<path
							d="M3 0a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V16h3a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1zm1 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5M4 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM7.5 5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5"
						/>
					</svg>
				</span>
			</div>
			<span class="truncate text-base whitespace-nowrap text-neutral-800">
				{property?.name ?? 'Property'}
			</span>
		</div>
		<div class="flex items-center">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="14"
				height="14"
				fill="currentColor"
				class="text-neutral-400"
				viewBox="0 0 16 16"
			>
				<path
					fill-rule="evenodd"
					d="M1 8a.5.5 0 0 1 .5-.5h11.793l-3.147-3.146a.5.5 0 0 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L13.293 8.5H1.5A.5.5 0 0 1 1 8"
				/>
			</svg>
		</div>
	</div>
	{#if hoverTooltipVisible}
		<div
			class="fixed z-50 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
			style={`left: ${hoverTooltipX}px; top: ${hoverTooltipY}px;`}
		>
			Go to property
		</div>
	{/if}
</a>
