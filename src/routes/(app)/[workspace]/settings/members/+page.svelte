<script>
	import InviteModal from '$lib/components/InviteModal.svelte';

	export let data;

	const roleLabels = {
		admin: 'Admin',
		member: 'Member',
		owner: 'Owner',
		property_owner: 'Property Owner',
		vendor: 'Vendor'
	};

	let showInviteModal = false;
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold text-neutral-900">Members</h1>
			<p class="text-sm text-neutral-500">Manage who has access to this workspace.</p>
		</div>
		<div class="flex items-center gap-2">
<button
				class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
				on:click={(e) => { e.currentTarget.blur(); showInviteModal = true; }}
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="0.4" class="bi bi-person-plus" viewBox="0 0 16 16">
					<path d="M6 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H1s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C9.516 10.68 8.289 10 6 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h9.996z"/>
					<path fill-rule="evenodd" d="M13.5 5a.5.5 0 0 1 .5.5V7h1.5a.5.5 0 0 1 0 1H14v1.5a.5.5 0 0 1-1 0V8h-1.5a.5.5 0 0 1 0-1H13V5.5a.5.5 0 0 1 .5-.5z"/>
				</svg>
				Invite
			</button>
		</div>
	</div>
	<div class="flex items-stretch gap-3">
		<div
			class="flex w-80 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3"
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="shrink-0 text-neutral-400" viewBox="0 0 16 16">
				<path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0" />
			</svg>
			<input
				class="w-full border-0 bg-transparent text-sm text-neutral-700 outline-none focus:ring-0 focus:outline-none"
				placeholder="Search by name or email"
			/>
		</div>
		<button
			class="rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-700"
		>
			All
		</button>
	</div>
	<div class="overflow-hidden rounded-xl border border-neutral-200 bg-white">
		<div
			class="grid grid-cols-[2fr_1fr] gap-4 border-b border-neutral-200 bg-neutral-50 px-5 py-3 text-xs font-semibold tracking-[0.12em] text-neutral-500 uppercase"
		>
			<div>Name</div>
			<div>Role</div>
		</div>
		{#await data.members}
			<div class="divide-y divide-neutral-100">
				{#each Array(3) as _, i}
					<div class="grid grid-cols-[2fr_1fr] gap-4 border-t border-neutral-100 px-5 py-3">
						<div class="shimmer h-4 rounded" style="width: {i % 2 === 0 ? '8rem' : '6rem'}"></div>
						<div class="shimmer h-5 w-16 rounded-full"></div>
					</div>
				{/each}
			</div>
		{:then members}
			{#each members as member}
				<div class="grid grid-cols-[2fr_1fr] gap-4 border-t border-neutral-100 px-5 py-3 text-sm">
					<div class="flex items-center gap-1.5 text-neutral-800">
						{member.users?.name ?? '—'}
						{#if member.user_id === data.currentUserId}
							<span class="text-xs text-neutral-400">(You)</span>
						{/if}
					</div>
					<div>
						<span class="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600">
							{roleLabels[member.role] ?? member.role}
						</span>
					</div>
				</div>
			{:else}
				<div class="px-5 py-4 text-sm text-neutral-600">No members yet.</div>
			{/each}
		{/await}
	</div>
</div>

{#if showInviteModal}
	<InviteModal on:close={() => (showInviteModal = false)} />
{/if}

<style>
	@keyframes shimmer {
		0% { background-position: -200% 0; }
		100% { background-position: 200% 0; }
	}
	.shimmer {
		background: linear-gradient(90deg, #f5f5f4 25%, #e8e5e3 50%, #f5f5f4 75%);
		background-size: 200% 100%;
		animation: shimmer 1.6s ease-in-out infinite;
	}
</style>
