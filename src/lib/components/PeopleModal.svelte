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

<svelte:body />
