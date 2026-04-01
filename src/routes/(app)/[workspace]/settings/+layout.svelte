<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { goto, afterNavigate } from '$app/navigation';
	import { fade, scale } from 'svelte/transition';
	import { clearSessionCaches } from '$lib/stores/clearSessionCaches';

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	const items = [
		{ id: 'integrations', label: 'Integrations', href: 'integrations' },
		{ id: 'members', label: 'Members', href: 'members' }
	];

	$: activeHref =
		items.find((item) => $page.url.pathname === `${basePath}/settings/${item.href}`)?.href ?? null;

	// Module-level so it survives tab switches within settings
	let returnTo = null;

	afterNavigate(({ from }) => {
		if (from && !from.url.pathname.includes('/settings/')) {
			returnTo = from.url.pathname + from.url.search;
		}
	});

	$: exitUrl = returnTo ?? (workspaceSlug ? `/${workspaceSlug}` : '/');

	let showLogoutModal = false;

	const handleLogoutSubmit = () => {
		clearSessionCaches();
	};

	function onKeydown(e) {
		if (e.key !== 'Escape') return;
		if (showLogoutModal) {
			showLogoutModal = false;
			return;
		}
		if (!document.querySelector('[role="dialog"]')) {
			goto(exitUrl);
		}
	}
</script>

<svelte:window on:keydown={onKeydown} />

<div class="min-h-screen bg-white text-neutral-900">
	<div class="flex min-h-screen">
		<aside class="w-1/6 border-r border-neutral-200 bg-neutral-50/80">
			<div class="px-5 pt-6">
				<button
					type="button"
					on:click={() => goto(exitUrl)}
					class="inline-flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900"
				>
					<span aria-hidden="true">←</span>
					Back to app
				</button>
			</div>
			<div class="px-5 pt-6 pb-8">
				<div class="space-y-1">
					{#each items as item}
						<a
							href={`${basePath}/settings/${item.href}`}
							class={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
								activeHref === item.href
									? 'bg-neutral-200/50 text-neutral-900'
									: 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
							}`}
						>
							<span>{item.label}</span>
						</a>
					{/each}
					<button
						type="button"
						on:click={(e) => {
							e.currentTarget.blur();
							showLogoutModal = true;
						}}
						class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-red-500 transition hover:bg-red-50 hover:text-red-600"
					>
						Log out
					</button>
				</div>
			</div>
		</aside>
		<main class="flex-1 px-10 py-8">
			<slot />
		</main>
	</div>
</div>

<svelte:body />
