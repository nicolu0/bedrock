<script>
	import { fade, scale } from 'svelte/transition';
	import { createEventDispatcher } from 'svelte';
	import { page } from '$app/stores';
	import { updatePersonInCache } from '$lib/stores/peopleCache.js';

	/** @type {{ id?: string, name?: string, email?: string, role?: string, trade?: string, notes?: string } | null} */
	export let person = null;

	const dispatch = createEventDispatcher();

	let name = person?.name ?? '';
	let email = person?.email ?? '';
	let trade = person?.trade ?? '';
	let notes = person?.notes ?? '';
	let role = person?.role ?? 'vendor';
	let roleOpen = false;
	let submitting = false;
	let error = '';
	/** @type {string | null} */
	let optimisticId = null;

	const isEdit = person != null;
	const roles = ['admin', 'member', 'owner', 'vendor'];
	const inviteEligibleRoles = new Set(['admin', 'member']);
	$: inviteEligible = inviteEligibleRoles.has(role);
	/** @param {string} value */
	const formatRole = (value) => value[0].toUpperCase() + value.slice(1);

	function close() {
		dispatch('close');
	}

	/** @param {KeyboardEvent} e */
	function onKeydown(e) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
		}
	}

	/** @param {string} nextRole */
	function selectRole(nextRole) {
		role = nextRole;
		roleOpen = false;
		if (role !== 'vendor') {
			trade = '';
		}
	}

	async function submit() {
		error = '';

		if (!name.trim() || !email.trim() || (role === 'vendor' && !trade.trim())) {
			error =
				role === 'vendor' ? 'Name, email, and trade are required.' : 'Name and email are required.';
			return;
		}

		submitting = true;
		const trimmedName = name.trim();
		const trimmedEmail = email.trim();
		const trimmedTrade = role === 'vendor' ? trade.trim() : '';
		const trimmedNotes = notes.trim();
		try {
			const personId = person?.id;
			if (isEdit && !personId) {
				error = 'Something went wrong.';
				return;
			}
			if (isEdit) {
				const previousPerson = { ...person };
				const optimisticPerson = {
					...previousPerson,
					name: trimmedName,
					email: trimmedEmail,
					role,
					trade: role === 'vendor' ? trimmedTrade : null,
					notes: trimmedNotes || null
				};
				updatePersonInCache(optimisticPerson);
				close();
				try {
					const res = await fetch('/api/people', {
						method: 'PATCH',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							id: personId,
							workspace: $page.params.workspace,
							name: trimmedName,
							email: trimmedEmail,
							role,
							trade: role === 'vendor' ? trimmedTrade : null,
							notes: trimmedNotes || null
						})
					});
					const json = await res.json();
					if (res.ok) {
						updatePersonInCache(json);
					} else {
						updatePersonInCache(previousPerson);
					}
				} catch {
					updatePersonInCache(previousPerson);
				} finally {
					submitting = false;
				}
				return;
			}
			const tempId = globalThis.crypto?.randomUUID
				? `temp-${globalThis.crypto.randomUUID()}`
				: `temp-${Date.now()}`;
			optimisticId = tempId;
			dispatch('optimistic', {
				id: tempId,
				name: trimmedName,
				email: trimmedEmail,
				role,
				trade: role === 'vendor' ? trimmedTrade : null,
				notes: trimmedNotes || null,
				pending: inviteEligible
			});
			const res = await fetch('/api/people', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace: $page.params.workspace,
					name: trimmedName,
					email: trimmedEmail,
					role,
					trade: role === 'vendor' ? trimmedTrade : null,
					notes: trimmedNotes || null
				})
			});
			const json = await res.json();
			if (!res.ok) {
				if (optimisticId) {
					dispatch('optimisticError', optimisticId);
					optimisticId = null;
				}
				error = json.error ?? 'Something went wrong.';
			} else {
				dispatch('saved', { person: json, tempId: optimisticId });
				optimisticId = null;
				close();
			}
		} catch (e) {
			if (optimisticId) {
				dispatch('optimisticError', optimisticId);
				optimisticId = null;
			}
			error = 'Something went wrong.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:window on:keydown={onKeydown} on:click={() => (roleOpen = false)} />

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
		aria-labelledby="people-modal-title"
	>
		<!-- Header -->
		<div class="flex items-center justify-between">
			<div id="people-modal-title" class="text-lg font-medium text-neutral-800">
				{isEdit ? 'Edit person' : 'Add person'}
			</div>
			<button
				class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
				on:click={close}
				type="button"
				aria-label="Close"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					fill="currentColor"
					viewBox="0 0 16 16"
				>
					<path
						d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"
					/>
				</svg>
			</button>
		</div>

		<!-- Body -->
		<div class="mt-5 flex flex-col gap-3">
			{#if error}
				<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{error}</p>
			{/if}

			<div class="grid grid-cols-[1.6fr_1fr] gap-3">
				<input
					type="text"
					bind:value={name}
					placeholder="Name"
					required
					class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
				/>
				<div class="relative" on:click|stopPropagation>
					<button
						type="button"
						class="flex w-full items-center justify-between rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 transition hover:border-stone-400"
						on:click|stopPropagation={() => (roleOpen = !roleOpen)}
						aria-haspopup="listbox"
						aria-expanded={roleOpen}
					>
						<span class="text-neutral-500">Role</span>
						<span class="font-medium text-neutral-800">{formatRole(role)}</span>
						<svg
							class={`ml-2 h-4 w-4 text-neutral-400 transition ${roleOpen ? 'rotate-180' : ''}`}
							viewBox="0 0 16 16"
							fill="currentColor"
							aria-hidden="true"
						>
							<path
								d="M3.204 5.293a.75.75 0 0 1 1.06-.083L8 8.293l3.736-3.083a.75.75 0 0 1 .954 1.148l-4.2 3.465a.75.75 0 0 1-.954 0l-4.2-3.465a.75.75 0 0 1-.083-1.06Z"
							/>
						</svg>
					</button>
					{#if roleOpen}
						<div
							class="absolute z-10 mt-2 w-full rounded-xl border border-neutral-200 bg-white p-1 text-sm text-neutral-700 shadow-lg"
							role="listbox"
						>
							{#each roles as option}
								<button
									type="button"
									class={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition ${option === role ? 'bg-neutral-100 text-neutral-900' : 'hover:bg-neutral-50'}`}
									on:click={() => selectRole(option)}
									role="option"
									aria-selected={option === role}
								>
									<span>{formatRole(option)}</span>
									{#if option === role}
										<svg
											class="h-4 w-4 text-neutral-500"
											viewBox="0 0 16 16"
											fill="currentColor"
											aria-hidden="true"
										>
											<path
												d="M6.173 12.414 2.5 8.74l1.06-1.06 2.613 2.613 6.267-6.267 1.06 1.06-7.327 7.327Z"
											/>
										</svg>
									{/if}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			</div>
			<input
				type="email"
				bind:value={email}
				placeholder="Email"
				required
				class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
			/>
			{#if role === 'vendor'}
				<input
					type="text"
					bind:value={trade}
					placeholder="Trade (e.g. Plumber)"
					required
					class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
				/>
			{/if}
			<textarea
				bind:value={notes}
				placeholder="Notes (optional)"
				rows="3"
				class="resize-none rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
			></textarea>
		</div>

		<!-- Footer -->
		<div class="mt-5 flex items-center justify-end gap-2">
			<button
				type="button"
				on:click={close}
				class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
			>
				Cancel
			</button>
			<button
				type="button"
				on:click={submit}
				disabled={submitting}
				class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
			>
				{submitting
					? isEdit
						? 'Saving…'
						: inviteEligible
							? 'Sending…'
							: 'Adding…'
					: isEdit
						? 'Save changes'
						: inviteEligible
							? 'Send invite'
							: 'Add person'}
			</button>
		</div>
	</div>
</div>
