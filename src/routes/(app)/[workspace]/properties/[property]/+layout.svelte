<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { getContext, setContext } from 'svelte';
	import { writable } from 'svelte/store';
	import SidebarButton from '$lib/components/SidebarButton.svelte';
	import { toggleChatPanel } from '$lib/stores/rightPanel.js';

	const showNewUnitModal = writable(false);
	setContext('showNewUnitModal', showNewUnitModal);
	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();

	export let data;
	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: propertySlug = $page.params.property;
	$: currentPath = $page.url.pathname;

	let propertyTitle = propertySlug
		? propertySlug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
		: 'Property';

	$: {
		const propData = data.properties;
		const slug = propertySlug;
		if (propData && slug) {
			const resolve = (list) => {
				if (!Array.isArray(list)) return;
				const match = list.find((p) => {
					const s = p.name
						.toLowerCase()
						.trim()
						.replace(/[^a-z0-9]+/g, '-')
						.replace(/(^-|-$)+/g, '');
					return s === slug;
				});
				if (match?.name) propertyTitle = match.name;
			};
			if (propData instanceof Promise) propData.then(resolve);
			else resolve(propData);
		}
	}
	const tabs = [
		{ id: 'issues', label: 'All issues', href: '' },
		{ id: 'units', label: 'Units', href: 'units' }
	];
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex items-center justify-between border-b border-neutral-200 py-2.5 pr-5 pl-6">
		<div class="flex items-center gap-2">
			<button
				type="button"
				aria-label="Open sidebar"
				class="rounded-md p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800 lg:hidden"
				on:click={openSidebar}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="12"
					height="12"
					fill="currentColor"
					class="bi bi-layout-sidebar"
					viewBox="0 0 16 16"
				>
					<path
						d="M0 3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm5-1v12h9a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zM4 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h2z"
					/>
				</svg>
			</button>
			<h1 class="text-sm font-normal text-neutral-700">{propertyTitle}</h1>
		</div>
		<div class="flex items-center gap-2">
			{#if currentPath === `${basePath}/properties/${propertySlug}/units`}
				<button
					type="button"
					on:click={() => ($showNewUnitModal = true)}
					class="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
				>
					+ New unit
				</button>
			{/if}
			<SidebarButton onClick={toggleChatPanel} />
		</div>
	</div>

	<div class="px-6 py-2">
		<div class="flex items-center gap-2">
			{#each tabs as tab}
				<a
					href={`${basePath}/properties/${propertySlug}${tab.href ? `/${tab.href}` : ''}`}
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
	<div class="flex-1 overflow-y-auto">
		<slot />
	</div>
</div>
