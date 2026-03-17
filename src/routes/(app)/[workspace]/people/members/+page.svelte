<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import PeopleModal from '$lib/components/PeopleModal.svelte';
	import { peopleCache } from '$lib/stores/peopleCache.js';

	export let data;

	let editingPerson = null;
	let openRowMenu = null;
	let hoveredRow = null;
	let deletingIds = new Set();

	$: workspaceSlug = $page.params.workspace;

	$: people =
		$peopleCache.workspace === workspaceSlug && $peopleCache.data != null
			? $peopleCache.data
			: null;
	$: members = Array.isArray(people) ? people.filter((person) => person.role === 'member') : [];

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
		deletingIds = new Set([...deletingIds, person.id]);
		openRowMenu = null;
		try {
			const res = await fetch('/api/people', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: person.id, workspace: workspaceSlug })
			});
			if (!res.ok) throw new Error('Failed to delete person');
			await invalidate('app:people');
		} catch (error) {
			deletingIds = new Set([...deletingIds].filter((id) => id !== person.id));
			console.error(error);
		}
	}

	function onSaved() {
		editingPerson = null;
		invalidate('app:people');
	}
</script>

<div class="space-y-2">
	<div>
		{#if people === null}
			<div>
				{#each { length: 4 } as _}
					<div class="grid grid-cols-[0.6fr_1.6fr_1fr_2fr_2rem] gap-4 px-6 py-3">
						<div class="skeleton h-5 w-16 rounded-sm"></div>
						<div class="skeleton h-4 w-32"></div>
						<div></div>
						<div class="skeleton h-4 w-40"></div>
						<div></div>
					</div>
				{/each}
			</div>
		{:else if members.length}
			<div
				class="grid grid-cols-[0.6fr_1.6fr_1fr_2fr_2rem] gap-4 px-6 py-2 text-xs text-neutral-500"
			>
				<div>Role</div>
				<div>Name</div>
				<div aria-hidden="true"></div>
				<div>Email</div>
				<div></div>
			</div>
			<div class="border-t border-neutral-200"></div>
			<div>
				{#each members as member}
					{#if !deletingIds.has(member.id)}
						<div
							class="group grid cursor-pointer grid-cols-[0.6fr_1.6fr_1fr_2fr_2rem] gap-4 px-6 py-3 text-sm text-neutral-700 hover:bg-neutral-50"
							on:mouseenter={() => (hoveredRow = member.id)}
							on:mouseleave={() => (hoveredRow = null)}
							on:click={(e) => {
								e.currentTarget.blur();
								openRowMenu = null;
								editingPerson = member;
							}}
							role="button"
							tabindex="0"
							on:keydown={(e) => e.key === 'Enter' && (editingPerson = member)}
						>
							<div class="flex items-center">
								<span
									class={`rounded-sm px-2 py-1 text-xs font-medium ${roleBadgeClass(member.role)}`}
								>
									{formatRole(member.role)}
								</span>
							</div>
							<div class="flex items-center gap-1.5 truncate">
								<span class="truncate">{member.name}</span>
								{#if member.user_id && data.currentUserId && member.user_id === data.currentUserId}
									<span class="text-xs text-neutral-400">(You)</span>
								{/if}
							</div>
							<div aria-hidden="true"></div>
							<div class="truncate text-neutral-500">{member.email ?? '—'}</div>
							<div class="relative flex items-center">
								<button
									data-row-menu-toggle="true"
									class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredRow === member.id || openRowMenu === member.id ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100`}
									on:click|stopPropagation={() =>
										(openRowMenu = openRowMenu === member.id ? null : member.id)}
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
								{#if openRowMenu === member.id}
									<div
										data-row-menu="true"
										class="absolute top-full right-0 z-20 mt-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
										on:click|stopPropagation
									>
										<button
											class="flex w-full px-3 py-2 text-left text-rose-600 hover:bg-neutral-50"
											on:click={() => deletePerson(member)}
											type="button"
										>
											Delete
										</button>
									</div>
								{/if}
							</div>
						</div>
					{/if}
				{/each}
			</div>
		{:else}
			<div class="px-6 py-3 text-sm text-neutral-400">No members yet.</div>
		{/if}
	</div>
</div>

{#if editingPerson}
	<PeopleModal person={editingPerson} on:saved={onSaved} on:close={() => (editingPerson = null)} />
{/if}
