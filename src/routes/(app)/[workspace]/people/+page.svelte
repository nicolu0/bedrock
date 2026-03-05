<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import {
		peopleCache,
		primePeopleCache,
		mergePeopleIntoCache,
		updatePersonInCache,
		removePersonFromCache
	} from '$lib/stores/peopleCache.js';
	import PeopleModal from '$lib/components/PeopleModal.svelte';

	export let data;

	let editingPerson = null;
	let openRowMenu = null;
	let hoveredRow = null;

	$: workspaceSlug = $page.params.workspace;

	$: people =
		$peopleCache.workspace === workspaceSlug && $peopleCache.data != null
			? $peopleCache.data
			: null;

	$: if (browser && data.people) {
		data.people.then((v) => mergePeopleIntoCache(workspaceSlug, v));
	}

	const formatRole = (role) => {
		if (!role) return 'Member';
		return role[0].toUpperCase() + role.slice(1);
	};

	const roleBadgeClass = (role) => {
		switch (role) {
			case 'admin':
				return 'bg-rose-50 text-rose-600';
			case 'owner':
				return 'bg-green-50 text-green-700';
			case 'vendor':
				return 'bg-yellow-50 text-yellow-700';
			case 'member':
			default:
				return 'bg-sky-50 text-sky-600';
		}
	};

	onMount(() => {
		const handleDocumentClick = (event) => {
			if (!openRowMenu) return;
			const path = event.composedPath?.() ?? [];
			const isMenuClick = path.some(
				(node) => node?.dataset?.rowMenu === 'true' || node?.dataset?.rowMenuToggle === 'true'
			);
			if (!isMenuClick) openRowMenu = null;
		};

		document.addEventListener('click', handleDocumentClick);
		return () => document.removeEventListener('click', handleDocumentClick);
	});

	async function deletePerson(person) {
		if (!person?.id) return;
		const previous = people;
		removePersonFromCache(person.id);
		openRowMenu = null;
		try {
			const res = await fetch('/api/people', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: person.id, workspace: workspaceSlug })
			});
			if (!res.ok) {
				throw new Error('Failed to delete person');
			}
		} catch (error) {
			primePeopleCache(workspaceSlug, previous ?? []);
			console.error(error);
		}
	}
	function onSaved(e) {
		const person = e.detail;
		if (!editingPerson) return;
		updatePersonInCache(person);
		editingPerson = null;
	}
</script>

<div class="space-y-2">
	<div>
		{#if people !== null}
			{#if people?.length}
				<div
					class="grid grid-cols-[0.6fr_2fr_1fr_1.5fr_2rem] gap-4 px-6 py-2 text-xs text-neutral-500"
				>
					<div>Role</div>
					<div>Name</div>
					<div>Trade</div>
					<div>Email</div>
					<div></div>
				</div>
				<div class="border-t border-neutral-200"></div>
				<div>
					{#each people as person}
						<div
							class="group grid cursor-pointer grid-cols-[0.6fr_2fr_1fr_1.5fr_2rem] gap-4 px-6 py-3 text-sm text-neutral-700 hover:bg-neutral-50"
							on:mouseenter={() => (hoveredRow = person.id)}
							on:mouseleave={() => (hoveredRow = null)}
							on:click={(e) => {
								e.currentTarget.blur();
								openRowMenu = null;
								editingPerson = person;
							}}
							role="button"
							tabindex="0"
							on:keydown={(e) => e.key === 'Enter' && (editingPerson = person)}
						>
							<div class="flex items-center">
								<span
									class={`rounded-sm px-2 py-1 text-xs font-medium ${roleBadgeClass(person.role)}`}
								>
									{formatRole(person.role)}
								</span>
							</div>
							<div class="truncate">{person.name}</div>
							<div class="truncate text-neutral-500">{person.trade ?? '—'}</div>
							<div class="truncate text-neutral-500">{person.email ?? '—'}</div>
							<div class="relative flex items-center">
								<button
									data-row-menu-toggle="true"
									class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredRow === person.id || openRowMenu === person.id ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100`}
									on:click|stopPropagation={() =>
										(openRowMenu = openRowMenu === person.id ? null : person.id)}
									type="button"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="16"
										height="16"
										fill="currentColor"
										class="bi bi-three-dots"
										viewBox="0 0 16 16"
									>
										<path
											d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3"
										/>
									</svg>
								</button>
								{#if openRowMenu === person.id}
									<div
										data-row-menu="true"
										class="absolute top-full right-0 z-20 mt-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
										on:click|stopPropagation
									>
										<button
											class="flex w-full px-3 py-2 text-left text-rose-600 hover:bg-neutral-50"
											on:click={() => deletePerson(person)}
											type="button"
										>
											Delete
										</button>
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<div class="px-6 py-3 text-sm text-neutral-400">No people yet.</div>
			{/if}
		{:else}
			<div
				class="grid grid-cols-[0.6fr_2fr_1fr_1.5fr_2rem] gap-4 px-6 py-2 text-xs text-neutral-500"
			>
				<div>Role</div>
				<div>Name</div>
				<div>Trade</div>
				<div>Email</div>
				<div></div>
			</div>
			<div class="border-t border-neutral-200"></div>
			<div>
				{#each Array(3) as _, i}
					<div class="grid grid-cols-[0.6fr_2fr_1fr_1.5fr_2rem] gap-4 px-6 py-3">
						<div class="shimmer h-4 w-14 rounded"></div>
						<div class="shimmer h-4 rounded" style="width: {i % 2 === 0 ? '8rem' : '6rem'}"></div>
						<div class="shimmer h-4 w-16 rounded"></div>
						<div class="shimmer h-4 rounded" style="width: {i % 3 === 0 ? '10rem' : '7rem'}"></div>
						<div class="shimmer h-4 w-6 rounded"></div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

{#if editingPerson}
	<PeopleModal person={editingPerson} on:saved={onSaved} on:close={() => (editingPerson = null)} />
{/if}

<style>
	@keyframes shimmer {
		0% {
			background-position: -200% 0;
		}
		100% {
			background-position: 200% 0;
		}
	}
	.shimmer {
		background: linear-gradient(90deg, #f5f5f4 25%, #e8e5e3 50%, #f5f5f4 75%);
		background-size: 200% 100%;
		animation: shimmer 1.6s ease-in-out infinite;
	}
</style>
