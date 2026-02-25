<script>
	import { fade } from 'svelte/transition';
	import { createEventDispatcher } from 'svelte';

	const dispatch = createEventDispatcher();

	let rows = [{ email: '', role: 'member' }];
	let submitting = false;
	let error = '';
	let success = '';

	function addRow() {
		rows = [...rows, { email: '', role: 'member' }];
	}

	function removeRow(i) {
		rows = rows.filter((_, idx) => idx !== i);
	}

	function close() {
		dispatch('close');
	}

	async function submit() {
		error = '';
		success = '';

		const invites = rows
			.map((r) => ({ email: r.email.trim(), role: r.role }))
			.filter((r) => r.email);

		if (!invites.length) {
			error = 'Please enter at least one email.';
			return;
		}

		submitting = true;
		try {
			const res = await fetch('/api/invites', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ invites })
			});
			const json = await res.json();
			if (!res.ok) {
				error = json.error ?? 'Failed to send invites.';
			} else {
				success = `Invite${json.invited.length > 1 ? 's' : ''} sent to ${json.invited.join(', ')}.`;
				rows = [{ email: '', role: 'member' }];
			}
		} catch (e) {
			error = 'Something went wrong.';
		} finally {
			submitting = false;
		}
	}
</script>

<!-- Backdrop -->
<div
	class="fixed inset-0 z-40 bg-neutral-900/10 backdrop-blur-[2px]"
	in:fade={{ duration: 80 }}
	on:click={close}
	role="presentation"
></div>

<!-- Modal -->
<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
	<div
		class="pointer-events-auto w-full max-w-lg rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
		in:fade={{ duration: 80 }}
		out:fade={{ duration: 80 }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="invite-modal-title"
	>
		<!-- Header -->
		<div class="flex items-center justify-between">
			<div id="invite-modal-title" class="text-lg font-medium text-neutral-800">Invite member</div>
			<button
				class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
				on:click={close}
				type="button"
				aria-label="Close"
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16">
					<path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708" />
				</svg>
			</button>
		</div>

		<!-- Body -->
		<div class="mt-5 flex flex-col gap-3">
			{#if error}
				<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{error}</p>
			{/if}
			{#if success}
				<p class="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-700">{success}</p>
			{/if}

			{#each rows as row, i}
				<div class="flex gap-2">
					<input
						type="email"
						bind:value={row.email}
						placeholder="teammate@company.com"
						class="flex-1 rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
					/>
					<select
						bind:value={row.role}
						class="rounded-xl border border-stone-300 px-3 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
					>
						<option value="admin">Admin</option>
						<option value="member">Member</option>
						<option value="property_owner">Property Owner</option>
						<option value="vendor">Vendor</option>
					</select>
					{#if rows.length > 1}
						<button
							type="button"
							on:click={() => removeRow(i)}
							class="rounded-xl border border-stone-200 px-3 py-2 text-sm text-neutral-400 hover:text-neutral-700"
						>×</button>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Footer -->
		<div class="mt-5 flex items-center justify-between">
			<button
				type="button"
				on:click={addRow}
				class="text-sm text-neutral-500 hover:text-neutral-800"
			>
				+ Add another
			</button>
			<div class="flex gap-2">
				<button
					type="button"
					on:click={close}
					class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50"
				>
					Cancel
				</button>
				<button
					type="button"
					on:click={submit}
					disabled={submitting}
					class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 disabled:opacity-50"
				>
					{submitting ? 'Sending…' : 'Send invite'}
				</button>
			</div>
		</div>
	</div>
</div>
