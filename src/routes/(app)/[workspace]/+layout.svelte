<script>
	// @ts-nocheck
	import { page } from '$app/stores';

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
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${currentPath === `${basePath}/${item.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
								>
									<span class="truncate">{item.label}</span>
								</a>
							{/each}
							<div class="mt-2">
								<div class="flex items-center justify-between">
									<div
										class="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-400"
									>
										<span class="truncate">{propertiesItem.label}</span>
									</div>
									<button
										type="button"
										class="rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100"
										on:click={() => (propertiesOpen = !propertiesOpen)}
										aria-label="Toggle properties"
									>
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
								</div>
								{#if propertiesOpen}
									<div class="mt-0 space-y-1">
										<a
											href={`${basePath}/${propertiesItem.href}`}
											data-sveltekit-preload-data="hover"
											class={`flex w-full items-center rounded-md px-2 py-1.5 text-sm transition ${currentPath === `${basePath}/${propertiesItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
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
														class={`flex w-full items-center rounded-md px-2 py-1.5 text-sm transition ${currentPath.startsWith(`${basePath}/${propertiesItem.href}/${slugify(property.name)}`) ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
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
								<a
									href={`${basePath}/${settingsItem.href}`}
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${currentPath === `${basePath}/${settingsItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
								>
									<span class="truncate">{settingsItem.label}</span>
								</a>
							</div>
						</div>
					</div>
				</div>
			</aside>
			<section class="flex flex-1 flex-col overflow-y-auto bg-white">
				<div class="w-full pt-3 pb-10">
					<slot />
				</div>
			</section>
		</div>
	</div>
{/if}
