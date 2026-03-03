<script>
	import { fade, scale } from 'svelte/transition';
	import { createEventDispatcher } from 'svelte';
	import { page } from '$app/stores';

	/** @type {{ id?: string, name?: string, email?: string, trade?: string, note?: string } | null} */
	export let vendor = null;

	const dispatch = createEventDispatcher();

	let name = vendor?.name ?? '';
	let email = vendor?.email ?? '';
	let trade = vendor?.trade ?? '';
	let note = vendor?.note ?? '';
	let submitting = false;
	let error = '';

	const isEdit = vendor != null;

	function close() {
		dispatch('close');
	}

	function onKeydown(e) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
		}
	}

	async function submit() {
		error = '';

		if (!name.trim() || !email.trim() || !trade.trim()) {
			error = 'Name, email, and trade are required.';
			return;
		}

		submitting = true;
		try {
			const res = await fetch('/api/vendors', {
				method: isEdit ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					...(isEdit ? { id: vendor.id } : {}),
					workspace: $page.params.workspace,
					name: name.trim(),
					email: email.trim(),
					trade: trade.trim(),
					note: note.trim() || null
				})
			});
			const json = await res.json();
			if (!res.ok) {
				error = json.error ?? 'Something went wrong.';
			} else {
				dispatch('saved', json);
				close();
			}
		} catch (e) {
			error = 'Something went wrong.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:window on:keydown={onKeydown} />

<!-- Backdrop -->
<div
	class="fixed inset-0 z-40 bg-neutral-900/20"
	transition:fade={{ duration: 120 }}
	on:click={close}
	role="presentation"
></div>

<!-- Modal -->
<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
	<div
		class="pointer-events-auto w-full max-w-lg rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
		transition:scale={{ duration: 140, start: 0.9 }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="vendor-modal-title"
	>
		<!-- Header -->
		<div class="flex items-center justify-between">
			<div id="vendor-modal-title" class="text-lg font-medium text-neutral-800">
				{isEdit ? 'Edit vendor' : 'Add vendor'}
			</div>
			<button
				class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
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

			<input
				type="text"
				bind:value={name}
				placeholder="Name"
				required
				class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
			/>
			<input
				type="email"
				bind:value={email}
				placeholder="Email"
				required
				class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
			/>
			<input
				type="text"
				bind:value={trade}
				placeholder="Trade (e.g. Plumber)"
				required
				class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
			/>
			<textarea
				bind:value={note}
				placeholder="Note (optional)"
				rows="3"
				class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500 resize-none"
			></textarea>
		</div>

		<!-- Footer -->
		<div class="mt-5 flex items-center justify-end gap-2">
			<button
				type="button"
				on:click={close}
				class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
			>
				Cancel
			</button>
			<button
				type="button"
				on:click={submit}
				disabled={submitting}
				class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-stone-400"
			>
				{submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add vendor'}
			</button>
		</div>
	</div>
</div>
