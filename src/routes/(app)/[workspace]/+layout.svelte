<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	onMount(() => {
		document.documentElement.style.overscrollBehavior = 'none';
		document.body.style.overscrollBehavior = 'none';
		return () => {
			document.documentElement.style.overscrollBehavior = '';
			document.body.style.overscrollBehavior = '';
		};
	});

	export let data;
	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: isSettingsRoute = $page.url.pathname.startsWith(`${basePath}/settings`);
	$: currentPath = $page.url.pathname;
	$: activeItem = [...navItems, propertiesItem, settingsItem].find(
		(item) => currentPath === `${basePath}/${item.href}`
	);
	$: propertiesPromise = data?.properties ?? Promise.resolve([]);
	const navItems = [
		{ id: 'inbox', label: 'Inbox', href: 'inbox' },
		{ id: 'my-issues', label: 'My issues', href: 'my-issues' },
		{ id: 'people', label: 'People', href: 'people' }
	];
	const propertiesItem = { id: 'properties', label: 'Properties', href: 'properties' };
	const settingsItem = { id: 'settings', label: 'Settings', href: 'settings' };
	let propertiesOpen = true;

	const slugify = (value) => {
		if (!value) return 'property';
		const base = value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
		return base || 'property';
	};
</script>

{#if isSettingsRoute}
	<slot />
{:else}
	<div class="h-screen bg-white text-neutral-900">
		<div class="flex h-screen flex-col md:flex-row">
			<aside class="flex h-screen w-1/6 flex-col border-r border-neutral-200 bg-neutral-50/80">
				<div class="flex h-full min-h-0 flex-col">
					<div class="flex flex-1 flex-col space-y-6 px-2 pt-4">
						<div class="flex items-center justify-between px-2 text-neutral-700">
							<div class="flex items-center gap-2">
								<div class="h-4.5 w-4.5 rounded-sm bg-neutral-700"></div>
								<span class="max-w-[120px] truncate text-sm text-neutral-700">
									{data?.workspace?.name ?? ''}
								</span>
							</div>
							<a
								href={`${basePath}/search`}
								data-sveltekit-preload-data="hover"
								class="rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									fill="currentColor"
									class="bi bi-search"
									viewBox="0 0 16 16"
								>
									<path
										d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"
									/>
								</svg>
							</a>
						</div>
						<div class="flex flex-1 flex-col gap-1 pb-4">
							{#each navItems as item}
								<a
									href={`${basePath}/${item.href}`}
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-normal transition ${currentPath === `${basePath}/${item.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
								>
									<span class="truncate">{item.label}</span>
								</a>
							{/each}
							<div class="mt-2">
								<button
									type="button"
									class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-neutral-400 transition hover:bg-neutral-100"
									on:click={() => (propertiesOpen = !propertiesOpen)}
								>
									<span class="truncate">{propertiesItem.label}</span>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="14"
										height="14"
										fill="currentColor"
										class={`transition ${propertiesOpen ? '' : '-rotate-90'}`}
										viewBox="0 0 16 16"
									>
										<path
											d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
										/>
									</svg>
								</button>
								{#if propertiesOpen}
									<div class="mt-1 space-y-1">
										<a
											href={`${basePath}/${propertiesItem.href}`}
											data-sveltekit-preload-data="hover"
											class={`flex w-full items-center rounded-md px-2 py-1.5 text-sm font-normal transition ${currentPath === `${basePath}/${propertiesItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
										>
											<span>All properties</span>
										</a>
										{#await propertiesPromise}
											<div class="px-2 py-1.5 text-xs text-neutral-400">Loading properties...</div>
										{:then properties}
											{#if properties?.length}
												{#each properties as property}
													<a
														href={`${basePath}/${propertiesItem.href}/${slugify(property.name)}`}
														data-sveltekit-preload-data="hover"
														class={`flex w-full items-center rounded-md px-2 py-1.5 text-sm font-normal transition ${currentPath.startsWith(`${basePath}/${propertiesItem.href}/${slugify(property.name)}`) ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
													>
														<span class="truncate">{property.name}</span>
													</a>
												{/each}
											{/if}
										{:catch}
											<div class="px-2 py-1.5 text-xs text-neutral-400">
												Unable to load properties.
											</div>
										{/await}
									</div>
								{/if}
							</div>
							<div class="mt-auto">
								<button
									type="button"
									on:click={() => goto(`${basePath}/${settingsItem.href}`)}
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${currentPath === `${basePath}/${settingsItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
								>
									<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16" class="shrink-0">
										<path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492M5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0"/>
										<path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.375l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115z"/>
									</svg>
								<span class="truncate">{settingsItem.label}</span>
								</button>
							</div>
						</div>
					</div>
				</div>
			</aside>
			<section class="flex-1 overflow-y-auto">
				<div class="w-full h-full">
					<slot />
				</div>
			</section>
		</div>
	</div>
{/if}
