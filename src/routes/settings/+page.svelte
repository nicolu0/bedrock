<script>
	import { enhance } from '$app/forms';

	export let data;
	export let form;

	const roleLabels = {
		admin: 'Admin',
		member: 'Member',
		owner: 'Owner',
		property_owner: 'Property Owner',
		vendor: 'Vendor'
	};

	let inviteRows = [{ email: '', role: 'member' }];

	function addRow() {
		inviteRows = [...inviteRows, { email: '', role: 'member' }];
	}

	function removeRow(i) {
		inviteRows = inviteRows.filter((_, idx) => idx !== i);
	}
</script>

<div class="min-h-screen bg-white px-6 py-10">
	<div class="mx-auto max-w-2xl">
		<div class="mb-8 flex items-center gap-4">
			<a href="/agentmvp" class="text-sm text-neutral-500 hover:text-neutral-800">← Back to app</a>
		</div>

		<h1 class="mb-8 text-2xl font-medium text-neutral-800">Team settings</h1>

		<!-- Members table -->
		<section class="mb-10">
			<h2 class="mb-4 text-sm font-medium uppercase tracking-wider text-neutral-500">Members</h2>
			<div class="overflow-hidden rounded-xl border border-stone-200">
				<table class="w-full text-sm">
					<thead class="bg-stone-50">
						<tr>
							<th class="px-4 py-3 text-left font-medium text-neutral-600">Name</th>
							<th class="px-4 py-3 text-left font-medium text-neutral-600">Role</th>
						</tr>
					</thead>
					<tbody>
						{#each data.members as member}
							<tr class="border-t border-stone-100">
								<td class="px-4 py-3 text-neutral-800">{member.users?.name ?? '—'}</td>
								<td class="px-4 py-3">
									<span class="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600">
										{roleLabels[member.role] ?? member.role}
									</span>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="2" class="px-4 py-6 text-center text-sm text-neutral-400">No members yet.</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<!-- Invite teammates -->
		<section>
			<h2 class="mb-4 text-sm font-medium uppercase tracking-wider text-neutral-500">Invite teammates</h2>

			{#if form?.invited}
				<p class="mb-4 rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-700">
					Invites sent to {form.invited.join(', ')}.
				</p>
			{/if}
			{#if form?.error}
				<p class="mb-4 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{form.error}</p>
			{/if}

			<form method="POST" action="?/invite" use:enhance class="flex flex-col gap-4">
				{#each inviteRows as row, i}
					<div class="flex gap-2">
						<input
							name="email"
							type="email"
							bind:value={row.email}
							placeholder="teammate@company.com"
							class="flex-1 rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						/>
						<select
							name="role"
							bind:value={row.role}
							class="rounded-xl border border-stone-300 px-3 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						>
							<option value="admin">Admin</option>
							<option value="member">Member</option>
							<option value="property_owner">Property Owner</option>
							<option value="vendor">Vendor</option>
						</select>
						{#if inviteRows.length > 1}
							<button
								type="button"
								on:click={() => removeRow(i)}
								class="rounded-xl border border-stone-200 px-3 py-2 text-sm text-neutral-400 hover:text-neutral-700"
							>×</button>
						{/if}
					</div>
				{/each}

				<div class="flex gap-3">
					<button
						type="button"
						on:click={addRow}
						class="rounded-xl border border-stone-300 px-4 py-2.5 text-sm text-neutral-600 transition-colors hover:bg-stone-50"
					>
						+ Add another
					</button>
					<button
						type="submit"
						class="rounded-xl bg-stone-800 px-4 py-2.5 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
					>
						Send invites
					</button>
				</div>
			</form>
		</section>
	</div>
</div>
