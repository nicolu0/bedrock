<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import PeopleModal from '$lib/components/PeopleModal.svelte';
	import {
		addPersonToCache,
		replacePersonInCache,
		removePersonFromCache
	} from '$lib/stores/peopleCache.js';
	import { newPersonModal } from '$lib/stores/peopleModal.js';

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: currentPath = $page.url.pathname;
	const tabs = [
		{ id: 'all', label: 'All people', href: '' },
		{ id: 'members', label: 'Members', href: 'members' },
		{ id: 'vendors', label: 'Vendors', href: 'vendors' },
		{ id: 'owners', label: 'Owners', href: 'owners' }
	];

	const openNewPersonModal = () => {
		newPersonModal.set(true);
	};

	const closeNewPersonModal = () => {
		newPersonModal.set(false);
	};

	const onNewPersonOptimistic = (e) => {
		addPersonToCache(e.detail, $page.params.workspace);
	};

	const onNewPersonSaved = (e) => {
		if (e.detail?.person) {
			replacePersonInCache(e.detail.tempId, e.detail.person, $page.params.workspace);
		} else {
			addPersonToCache(e.detail, $page.params.workspace);
		}
		closeNewPersonModal();
	};

	const onNewPersonOptimisticError = (e) => {
		removePersonFromCache(e.detail);
	};
</script>

<div class="space-y-0">
	<div class="flex items-center justify-between border-b border-neutral-200 px-6 py-2.5">
		<h1 class="text-sm font-normal text-neutral-700">People</h1>
		<button
			class="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
			on:click={(e) => {
				e.currentTarget.blur();
				openNewPersonModal();
			}}
		>
			+ New person
		</button>
	</div>

	<div class="border-b border-neutral-200 px-6 py-2">
		<div class="flex items-center gap-2">
			{#each tabs as tab}
				<a
					href={`${basePath}/people${tab.href ? `/${tab.href}` : ''}`}
					class={`rounded-md border border-neutral-200 px-2 py-1 text-xs transition ${
						(currentPath === `${basePath}/people` && tab.id === 'all') ||
						currentPath === `${basePath}/people/${tab.href}`
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

{#if $newPersonModal}
	<PeopleModal
		on:optimistic={onNewPersonOptimistic}
		on:optimisticError={onNewPersonOptimisticError}
		on:saved={onNewPersonSaved}
		on:close={closeNewPersonModal}
	/>
{/if}
