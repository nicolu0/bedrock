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
				class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-700"
			>
				Export CSV
			</button>
			<button
				class="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white"
				on:click={() => (showInviteModal = true)}
			>
				Invite
			</button>
		</div>
	</div>
	<div class="flex items-stretch gap-3">
		<div
			class="flex w-80 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3"
		>
			<span class="text-neutral-400">🔍</span>
			<input
				class="w-full border-0 bg-transparent text-sm text-neutral-700 outline-none"
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
		{#each data.members as member}
			<div class="grid grid-cols-[2fr_1fr] gap-4 border-t border-neutral-100 px-5 py-3 text-sm">
				<div class="text-neutral-800">{member.users?.name ?? '—'}</div>
				<div>
					<span class="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600">
						{roleLabels[member.role] ?? member.role}
					</span>
				</div>
			</div>
		{:else}
			<div class="px-5 py-4 text-sm text-neutral-600">No members yet.</div>
		{/each}
	</div>
</div>

{#if showInviteModal}
	<InviteModal on:close={() => (showInviteModal = false)} />
{/if}
