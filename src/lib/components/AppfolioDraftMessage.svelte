<script>
	// @ts-nocheck
	import { createEventDispatcher, onMount } from 'svelte';
	import { agentToasts } from '$lib/stores/agentToasts';
	const dispatch = createEventDispatcher();

	export let draft = null;
	export let approvedBy = null;

	let draftBody = draft?.body ?? '';
	let saveTimeout;
	let lastMessageKey = draft?.message_id ?? draft?.id ?? null;
	let textareaEl;
	let isApproving = false;
	let approvedByLocal = approvedBy ?? null;
	const APPROVAL_KEY = 'appfolio_approved_by';
	const getApprovalStorageKey = () =>
		`${APPROVAL_KEY}:${draft?.issue_id ?? 'unknown'}:${draft?.message_id ?? draft?.id ?? 'draft'}`;

	$: if (draft && (draft.message_id ?? draft.id) !== lastMessageKey) {
		lastMessageKey = draft.message_id ?? draft.id;
		draftBody = draft.body ?? '';
		if (textareaEl) {
			textareaEl.style.height = 'auto';
			textareaEl.style.height = `${textareaEl.scrollHeight}px`;
		}
	}

	$: if (textareaEl) {
		textareaEl.style.height = 'auto';
		textareaEl.style.height = `${textareaEl.scrollHeight}px`;
	}

	$: if (approvedBy && !approvedByLocal) {
		approvedByLocal = approvedBy;
	}

	$: if (approvedByLocal && typeof window !== 'undefined') {
		window.localStorage.setItem(getApprovalStorageKey(), approvedByLocal);
	}

	onMount(() => {
		if (typeof window === 'undefined') return;
		const stored = window.localStorage.getItem(getApprovalStorageKey());
		if (stored && !approvedByLocal) {
			approvedByLocal = stored;
		}
	});

	const showToast = (message, id) => {
		agentToasts.upsert({
			id: id ?? `appfolio-toast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
			message,
			stage: 'done'
		});
	};

	const saveDraft = async () => {
		if (!draft?.message_id && !draft?.issue_id) return;
		if (draftBody === draft?.body) return;
		try {
			const response = await fetch('/api/email-drafts', {
				method: 'PATCH',
				keepalive: true,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					draft.message_id
						? { message_id: draft.message_id, body: draftBody, channel: 'appfolio' }
						: { issue_id: draft.issue_id, body: draftBody, channel: 'appfolio' }
				)
			});
			const payload = await response.json().catch(() => null);
			if (response.ok) {
				draft.body = draftBody;
				if (payload?.draft) {
					draft = { ...draft, ...payload.draft };
				}
			}
		} catch {
			// ignore save failures
		}
	};

	const approveDraft = async () => {
		if (!draft?.issue_id) return;
		if (isApproving) return;
		isApproving = true;
		try {
			const response = await fetch('/api/appfolio-drafts/approve', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					issue_id: draft.issue_id,
					draft_id: draft.id ?? null,
					message_id: draft.message_id ?? null
				})
			});
			if (!response.ok) throw new Error('approve failed');
			const payload = await response.json().catch(() => null);
			approvedByLocal = payload?.approved_by ?? approvedByLocal ?? 'You';
			const assigneeName = payload?.assignee_name ?? null;
			showToast(
				assigneeName ? `Approved and assigned to ${assigneeName}.` : 'Approved and assigned.'
			);
		} catch {
			showToast('Appfolio approval failed.');
		} finally {
			isApproving = false;
		}
	};

	const queueSave = () => {
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => {
			saveDraft();
		}, 400);
		if (textareaEl) {
			textareaEl.style.height = 'auto';
			textareaEl.style.height = `${textareaEl.scrollHeight}px`;
		}
	};
</script>

{#if draft}
	<div class="overflow-hidden rounded-md border border-neutral-100 bg-white">
		<div class="bg-white">
			<div class="px-4 py-3">
				<div class="text-sm font-semibold text-neutral-900">Drafted reply</div>
			</div>
			<div class="border-t border-neutral-100 px-4 py-3">
				<textarea
					class="w-full resize-none border-0 bg-transparent p-0 text-sm text-neutral-700 ring-0 outline-none focus:ring-0 focus:outline-none"
					rows="2"
					bind:value={draftBody}
					bind:this={textareaEl}
					on:input={queueSave}
				/>
				<div class="mt-3 flex items-center justify-between">
					{#if approvedByLocal}
						<span class="text-xs font-semibold text-emerald-700">
							Approved by {approvedByLocal}
						</span>
					{:else}
						<button
							class="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-50"
							type="button"
							on:click={approveDraft}
							disabled={isApproving}
						>
							{#if isApproving}
								<span class="text-[10px] font-semibold">...</span>
							{:else}
								Approve
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									fill="currentColor"
									class="bi bi-check2"
									viewBox="0 0 16 16"
								>
									<path
										d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0"
									/>
								</svg>
							{/if}
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
