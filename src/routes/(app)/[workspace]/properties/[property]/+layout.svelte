<script>
	// @ts-nocheck
	import { page } from '$app/stores';

	export let data;
	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: propertySlug = $page.params.property;
	$: currentPath = $page.url.pathname;
	$: propertiesPromise = data?.properties ?? Promise.resolve([]);
	$: propertyTitle = propertySlug
		? propertySlug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
		: 'Property';
	$: if (propertiesPromise && propertySlug) {
		propertiesPromise.then((properties) => {
			const match = (properties ?? []).find((property) => {
				const slug = property.name
					.toLowerCase()
					.trim()
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/(^-|-$)+/g, '');
				return slug === propertySlug;
			});
			if (match?.name) {
				propertyTitle = match.name;
			}
		});
	}
	const tabs = [
		{ id: 'issues', label: 'All issues', href: '' },
		{ id: 'units', label: 'Units', href: 'units' }
	];
</script>

<div class="space-y-4">
	<div class="border-b border-neutral-100 px-6 pb-2">
		<div class="text-sm font-normal text-neutral-700">{propertyTitle}</div>
	</div>
	<div class="px-6">
		<div class="flex items-center gap-2">
			{#each tabs as tab}
				<a
					href={`${basePath}/properties/${propertySlug}${tab.href ? `/${tab.href}` : ''}`}
					data-sveltekit-preload-data="hover"
					class={`rounded-md border border-neutral-200 px-2 py-1 text-xs transition ${
						(currentPath === `${basePath}/properties/${propertySlug}` && tab.id === 'issues') ||
						currentPath === `${basePath}/properties/${propertySlug}/${tab.href}`
							? 'bg-neutral-200/50 text-neutral-900'
							: 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
					}`}
				>
					{tab.label}
				</a>
			{/each}
		</div>
	</div>
	<slot />
</div>
