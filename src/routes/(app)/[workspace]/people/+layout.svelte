<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import PeopleModal from '$lib/components/PeopleModal.svelte';
	import SidebarButton from '$lib/components/SidebarButton.svelte';
	import { toggleChatPanel } from '$lib/stores/rightPanel.js';
	import {
		addPersonToCache,
		replacePersonInCache,
		removePersonFromCache,
		updatePersonInCache
	} from '$lib/stores/peopleCache.js';
	import { newPersonModal } from '$lib/stores/peopleModal.js';

	$: workspaceSlug = $page.params.workspace;
	$: role = $page.data?.role;
	$: canViewPeople = role === 'admin' || role === 'bedrock' || role === 'member';
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: currentPath = $page.url.pathname;
	$: if (browser && workspaceSlug && role && !canViewPeople) goto(basePath);
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

	const onNewPersonOptimistic = (event) => {
		if (!event?.detail) return;
		addPersonToCache(event.detail, workspaceSlug);
	};

	const onNewPersonOptimisticError = (event) => {
		if (!event?.detail) return;
		removePersonFromCache(event.detail);
	};

	const onNewPersonSaved = (event) => {
		const payload = event?.detail;
		const person = payload?.person ?? payload;
		if (payload?.tempId) {
			replacePersonInCache(payload.tempId, person, workspaceSlug);
		} else if (person?.id) {
			updatePersonInCache(person);
		}
		closeNewPersonModal();
	};
</script>

{#if canViewPeople}
	<div class="flex h-full min-h-0 flex-col">
		<div class="flex items-center justify-between border-b border-neutral-200 py-2.5 pr-5 pl-6">
			<h1 class="text-sm font-normal text-neutral-700">People</h1>
			<div class="flex items-center gap-2">
				<button
					class="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
					on:click={(e) => {
						e.currentTarget.blur();
						openNewPersonModal();
					}}
				>
					+ New person
				</button>
				<SidebarButton onClick={toggleChatPanel} />
			</div>
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
		<div class="flex-1 overflow-y-auto">
			<slot />
		</div>
	</div>

	{#if $newPersonModal}
		<PeopleModal
			on:optimistic={onNewPersonOptimistic}
			on:optimisticError={onNewPersonOptimisticError}
			on:saved={onNewPersonSaved}
			on:close={closeNewPersonModal}
		/>
	{/if}
{/if}
