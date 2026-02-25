<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	const items = [
		{ id: 'preferences', label: 'Preferences', href: 'preferences' },
		{ id: 'members', label: 'Members', href: 'members' }
	];

	const isActive = (href) => $page.url.pathname === `${basePath}/settings/${href}`;

	function onKeydown(e) {
		if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
			history.back();
		}
	}
</script>

<svelte:window on:keydown={onKeydown} />

<div class="min-h-screen bg-white text-neutral-900">
	<div class="flex min-h-screen">
		<aside class="w-1/6 border-r border-neutral-200 bg-neutral-50/80">
			<div class="px-5 pt-6">
				<a
					href={`${basePath}/my-issues`}
					class="inline-flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900"
				>
					<span aria-hidden="true">←</span>
					Back to app
				</a>
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
				</div>
			</div>
		</aside>
		<main class="flex-1 px-10 py-8">
			<slot />
		</main>
	</div>
</div>
