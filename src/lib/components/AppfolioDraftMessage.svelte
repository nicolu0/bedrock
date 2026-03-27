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
	let isTranslating = false;
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
						? { message_id: draft.message_id, body: draftBody }
						: { issue_id: draft.issue_id, body: draftBody }
				)
			});
			if (response.ok) {
				draft.body = draftBody;
			}
		} catch {
			// ignore save failures
		}
	};

	const translateDraft = async () => {
		if (!draftBody?.trim()) {
			showToast('Nothing to translate.');
			return;
		}
		if (isTranslating) return;
		isTranslating = true;
		try {
			const response = await fetch('/api/translate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ body: draftBody })
			});
			if (!response.ok) throw new Error('translate failed');
			const payload = await response.json().catch(() => null);
			const translated = payload?.translation ?? '';
			if (!translated) throw new Error('empty translation');
			draftBody = translated;
			await saveDraft();
			showToast('Translated to Spanish.');
		} catch {
			showToast('Translation failed.');
		} finally {
			isTranslating = false;
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
					<button
						type="button"
						class="inline-flex items-center gap-2 text-xs text-neutral-500 transition hover:text-neutral-900 disabled:opacity-50"
						on:click={translateDraft}
						disabled={isTranslating}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="16"
							height="16"
							fill="currentColor"
							class="bi bi-globe"
							viewBox="0 0 16 16"
						>
							<path
								d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m7.5-6.923c-.67.204-1.335.82-1.887 1.855A8 8 0 0 0 5.145 4H7.5zM4.09 4a9.3 9.3 0 0 1 .64-1.539 7 7 0 0 1 .597-.933A7.03 7.03 0 0 0 2.255 4zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a7 7 0 0 0-.656 2.5zM4.847 5a12.5 12.5 0 0 0-.338 2.5H7.5V5zM8.5 5v2.5h2.99a12.5 12.5 0 0 0-.337-2.5zM4.51 8.5a12.5 12.5 0 0 0 .337 2.5H7.5V8.5zm3.99 0V11h2.653c.187-.765.306-1.608.338-2.5zM5.145 12q.208.58.468 1.068c.552 1.035 1.218 1.65 1.887 1.855V12zm.182 2.472a7 7 0 0 1-.597-.933A9.3 9.3 0 0 1 4.09 12H2.255a7 7 0 0 0 3.072 2.472M3.82 11a13.7 13.7 0 0 1-.312-2.5h-2.49c.062.89.291 1.733.656 2.5zm6.853 3.472A7 7 0 0 0 13.745 12H11.91a9.3 9.3 0 0 1-.64 1.539 7 7 0 0 1-.597.933M8.5 12v2.923c.67-.204 1.335-.82 1.887-1.855q.26-.487.468-1.068zm3.68-1h2.146c.365-.767.594-1.61.656-2.5h-2.49a13.7 13.7 0 0 1-.312 2.5m2.802-3.5a7 7 0 0 0-.656-2.5H12.18c.174.782.282 1.623.312 2.5zM11.27 2.461c.247.464.462.98.64 1.539h1.835a7 7 0 0 0-3.072-2.472c.218.284.418.598.597.933M10.855 4a8 8 0 0 0-.468-1.068C9.835 1.897 9.17 1.282 8.5 1.077V4z"
							/>
						</svg>
						{#if isTranslating}
							Translating...
						{:else}
							Translate to Spanish
						{/if}
					</button>
					{#if approvedByLocal}
						<span class="text-xs font-semibold text-emerald-700">
							Approved by {approvedByLocal}
						</span>
					{:else}
						<button
							class="inline-flex items-center justify-center rounded-full bg-neutral-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-50"
							type="button"
							on:click={approveDraft}
							disabled={isApproving}
						>
							{#if isApproving}
								<span class="text-[10px] font-semibold">...</span>
							{:else}
								Approve
							{/if}
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
