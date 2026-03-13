<script>
	// @ts-nocheck
	import { createEventDispatcher } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { updateNotificationInCache } from '$lib/stores/notificationsCache.js';

	export let notification;

	const dispatch = createEventDispatcher();
	let comment = '';
	let submitting = false;
	let error = '';
	let showIgnoreModal = false;

	const type = notification?.type ?? '';
	const senderEmail = notification?.meta?.sender_email ?? '';
	const subject = notification?.meta?.subject ?? notification?.title ?? '';
	const body = notification?.meta?.body ?? notification?.body ?? '';
	const summary = notification?.meta?.summary ?? '';

	const policyAction = type === 'allowed_unknown_behavior' ? 'behavior' : 'allow';

	function close() {
		dispatch('close');
	}

	async function submit(action) {
		if (!notification?.workspace_id) return;
		submitting = true;
		error = '';
		showIgnoreModal = false;
		try {
			const res = await fetch('/api/policy-agent', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace_id: notification.workspace_id,
					sender_email: senderEmail,
					action,
					comment,
					notification_id: notification.id
				})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = payload.error ?? 'Failed to update policy.';
				return;
			}
			updateNotificationInCache({
				id: notification.id,
				is_read: true,
				is_resolved: true,
				requires_action: false
			});
			dispatch('resolved');
		} catch (e) {
			error = 'Something went wrong.';
		} finally {
			submitting = false;
		}
	}

	function openIgnoreModal() {
		showIgnoreModal = true;
	}

	function closeIgnoreModal() {
		showIgnoreModal = false;
	}

	function onKeydown(event) {
		if (event.key === 'Escape' && showIgnoreModal) {
			closeIgnoreModal();
		}
	}
</script>

<svelte:window on:keydown={onKeydown} />

<div class="flex min-h-full flex-col">
	<div class="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
		<div>
			<div class="text-xs font-medium tracking-wide text-neutral-400 uppercase">Policy Review</div>
			<div class="mt-1 text-lg font-medium text-neutral-800">
				Email from {senderEmail || 'Unknown sender'}
			</div>
		</div>
		<button
			on:click={close}
			class="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
			aria-label="Close"
			type="button"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="20"
				height="20"
				fill="currentColor"
				viewBox="0 0 16 16"
			>
				<path
					d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"
				/>
			</svg>
		</button>
	</div>

	<div class="flex-1 space-y-6 px-6 py-6">
		<div>
			<div class="text-xs font-semibold tracking-wide text-neutral-400 uppercase">Subject</div>
			<div
				class="mt-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-700"
			>
				{subject || 'No subject'}
			</div>
		</div>

		<div>
			<div class="text-xs font-semibold tracking-wide text-neutral-400 uppercase">Message</div>
			<div
				class="mt-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm whitespace-pre-wrap text-neutral-700"
			>
				{body || 'No body content'}
			</div>
		</div>

		{#if type === 'allowed_unknown_behavior'}
			<div>
				<div class="text-xs font-semibold tracking-wide text-neutral-400 uppercase">
					Agent Summary
				</div>
				<div
					class="mt-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-700"
				>
					{summary || 'No summary available yet.'}
				</div>
			</div>
		{/if}

		<div>
			<div class="text-xs font-semibold tracking-wide text-neutral-400 uppercase">
				Policy Note (optional)
			</div>
			<textarea
				rows="4"
				bind:value={comment}
				class="mt-2 w-full rounded-xl border border-neutral-200 px-3.5 py-3 text-sm text-neutral-700 outline-none focus:border-neutral-400"
				placeholder={type === 'allowed_unknown_behavior'
					? 'Describe how Bedrock should handle these emails in the future.'
					: 'Optional: add context for why this sender should be allowed.'}
			></textarea>
		</div>

		{#if error}
			<div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
				{error}
			</div>
		{/if}
	</div>

	<div class="flex items-center justify-between border-t border-neutral-200 px-6 py-4">
		<button
			on:click={openIgnoreModal}
			class="rounded-xl border border-neutral-200 px-4 py-2 text-sm text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-800"
			type="button"
			disabled={submitting}
		>
			Ignore
		</button>
		<button
			on:click={() => submit(policyAction)}
			class="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-60"
			type="button"
			disabled={submitting}
		>
			Create Policy
		</button>
	</div>
</div>

{#if showIgnoreModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/20"
		transition:fade={{ duration: 120 }}
		on:click={closeIgnoreModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.96 }}
			role="dialog"
			aria-modal="true"
		>
			<div class="text-lg font-medium text-neutral-800">Ignore this email?</div>
			<p class="mt-2 text-sm text-neutral-600">
				You can block this sender or just ignore this one message.
			</p>
			<div class="mt-6 flex flex-col gap-3">
				<button
					on:click={() => submit('block')}
					class="rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition hover:border-neutral-300"
					type="button"
					disabled={submitting}
				>
					Block this email
				</button>
				<button
					on:click={() => submit('ignore')}
					class="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-60"
					type="button"
					disabled={submitting}
				>
					Ignore once
				</button>
				<button
					on:click={closeIgnoreModal}
					class="rounded-xl px-4 py-2 text-sm text-neutral-500 transition hover:text-neutral-700"
					type="button"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
