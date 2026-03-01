<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { goto, afterNavigate } from '$app/navigation';
	import { fade, scale } from 'svelte/transition';

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	const items = [
		{ id: 'integrations', label: 'Integrations', href: 'integrations' },
		{ id: 'preferences', label: 'Preferences', href: 'preferences' },
		{ id: 'members', label: 'Members', href: 'members' }
	];

	const isActive = (href) => $page.url.pathname === `${basePath}/settings/${href}`;

	// Module-level so it survives tab switches within settings
	let returnTo = null;

	afterNavigate(({ from }) => {
		if (from && !from.url.pathname.includes('/settings/')) {
			returnTo = from.url.pathname + from.url.search;
		}
	});

	$: exitUrl = returnTo ?? (workspaceSlug ? `/${workspaceSlug}` : '/');

	let showLogoutModal = false;

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
								isActive(item.href)
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

{#if showLogoutModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/20"
		transition:fade={{ duration: 120 }}
		on:click={() => (showLogoutModal = false)}
		role="presentation"
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.9 }}
			role="dialog"
			aria-modal="true"
			aria-labelledby="logout-modal-title"
		>
			<div class="flex items-center justify-between">
				<div id="logout-modal-title" class="text-lg font-medium text-neutral-800">Log out</div>
				<button
					type="button"
					on:click={() => (showLogoutModal = false)}
					class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
					aria-label="Close"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="24"
						height="24"
						fill="currentColor"
						viewBox="0 0 16 16"
					>
						<path
							d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"
						/>
					</svg>
				</button>
			</div>
			<p class="mt-2 text-sm text-neutral-500">Are you sure you want to log out?</p>
			<div class="mt-6 flex items-center justify-end gap-2">
				<button
					type="button"
					on:click={() => (showLogoutModal = false)}
					class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
				>
					Cancel
				</button>
				<form method="POST" action="/api/logout">
					<button
						type="submit"
						class="rounded-xl bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700 focus-visible:ring-1 focus-visible:ring-red-400 focus-visible:outline-none"
					>
						Log out
					</button>
				</form>
			</div>
		</div>
	</div>
{/if}
