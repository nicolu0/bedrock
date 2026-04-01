<script>
	// @ts-nocheck
	import { createEventDispatcher, onMount } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { agentToasts } from '$lib/stores/agentToasts';
	import { applyPolicyInsert } from '$lib/stores/policiesCache';
	import { diffWords } from '$lib/utils/textDiff';
	import { searchVendors } from '$lib/utils/vendorSearch';
	const dispatch = createEventDispatcher();

	export let draft = null;
	export let approvedBy = null;
	export let vendors = [];
	export let recommendedVendors = [];

	let draftBody = draft?.body ?? '';
	let saveTimeout;
	let lastMessageKey = draft?.message_id ?? draft?.id ?? null;
	let textareaEl;
	let isApproving = false;
	let approvedByLocal = approvedBy ?? null;
	let showTonePrompt = false;
	let tonePromptLoading = false;
	let tonePromptError = '';
	let draftOriginal = draft?.original_body ?? null;
	let draftDiff = draft?.draft_diff ?? null;
	const APPROVAL_KEY = 'appfolio_approved_by';
	const getApprovalStorageKey = () =>
		`${APPROVAL_KEY}:${draft?.issue_id ?? 'unknown'}:${draft?.message_id ?? draft?.id ?? 'draft'}`;

	// Vendor picker state
	let showVendorPicker = false;
	let vendorSearch = '';
	let pickerEl;

	$: filteredVendors = searchVendors(vendors, vendorSearch);
	$: suggestedVendors = recommendedVendors ?? [];

	// IDs already in recommended so we don't show duplicates in "All" section
	$: suggestedIds = new Set(suggestedVendors.map((v) => v.id));

	$: filteredSuggested = suggestedVendors.filter(
		(v) => !vendorSearch || searchVendors([v], vendorSearch).length > 0
	);
	$: filteredAll = filteredVendors.filter((v) => !suggestedIds.has(v.id));

	// Current recipient vendor display name
	$: currentRecipientEmail = draft?.recipient_email ?? null;
	$: currentVendorName = currentRecipientEmail
		? (vendors.find((v) => v.email?.toLowerCase() === currentRecipientEmail?.toLowerCase())?.name ??
			recommendedVendors.find(
				(v) => v.email?.toLowerCase() === currentRecipientEmail?.toLowerCase()
			)?.name ??
			currentRecipientEmail)
		: null;

	$: if (draft && (draft.message_id ?? draft.id) !== lastMessageKey) {
		lastMessageKey = draft.message_id ?? draft.id;
		draftBody = draft.body ?? '';
		draftOriginal = draft?.original_body ?? null;
		draftDiff = draft?.draft_diff ?? null;
		if (textareaEl) {
			textareaEl.style.height = 'auto';
			textareaEl.style.height = `${textareaEl.scrollHeight}px`;
		}
	}

	$: if (draft) {
		if (draft?.original_body && draftOriginal !== draft.original_body) {
			draftOriginal = draft.original_body;
		}
		if (draft?.draft_diff && draftDiff !== draft.draft_diff) {
			draftDiff = draft.draft_diff;
		}
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
					draftOriginal = draft?.original_body ?? draftOriginal;
					draftDiff = draft?.draft_diff ?? draftDiff;
				}
			}
		} catch {
			// ignore save failures
		}
	};

	const closeTonePrompt = () => {
		if (tonePromptLoading) return;
		showTonePrompt = false;
		tonePromptError = '';
	};

	const openTonePrompt = () => {
		tonePromptError = '';
		showTonePrompt = true;
	};

	const saveTonePolicy = async () => {
		if (!draft?.issue_id) {
			tonePromptError = 'Draft is missing an issue.';
			return null;
		}
		if (!hasToneDiff) {
			tonePromptError = 'No changes to learn from.';
			return null;
		}
		tonePromptLoading = true;
		tonePromptError = '';
		try {
			const response = await fetch('/api/policies/tone', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					issue_id: draft.issue_id,
					original_body: originalBodyForDiff,
					updated_body: draftBody,
					diff: diffSegments
				})
			});
			const result = await response.json().catch(() => null);
			if (!response.ok) {
				throw new Error(result?.error ?? 'Unable to save tone policy.');
			}
			if (result?.policy) {
				applyPolicyInsert(result.policy);
			}
			return result?.policy ?? null;
		} catch (err) {
			tonePromptError = err?.message ?? 'Unable to save tone policy.';
			return null;
		} finally {
			tonePromptLoading = false;
		}
	};

	const changeVendor = async (vendor) => {
		if (!draft?.issue_id && !draft?.message_id) return;
		showVendorPicker = false;
		vendorSearch = '';
		const prevEmail = draft.recipient_email;
		draft = { ...draft, recipient_email: vendor.email };
		try {
			const body = draft.message_id
				? { message_id: draft.message_id, recipient_email: vendor.email, channel: 'appfolio' }
				: { issue_id: draft.issue_id, recipient_email: vendor.email, channel: 'appfolio' };
			const response = await fetch('/api/email-drafts', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				draft = { ...draft, recipient_email: prevEmail };
				showToast('Failed to update vendor.');
			}
		} catch {
			draft = { ...draft, recipient_email: prevEmail };
			showToast('Failed to update vendor.');
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

	const approveOnce = async () => {
		closeTonePrompt();
		await approveDraft();
	};

	const approveAndSave = async () => {
		if (tonePromptLoading) return;
		const policy = await saveTonePolicy();
		if (!policy) return;
		closeTonePrompt();
		await approveDraft();
	};

	const handleApproveClick = () => {
		if (isApproving || approvedByLocal) return;
		if (hasToneDiff) {
			openTonePrompt();
			return;
		}
		approveDraft();
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

	const handleClickOutside = (e) => {
		if (showVendorPicker && pickerEl && !pickerEl.contains(e.target)) {
			showVendorPicker = false;
			vendorSearch = '';
		}
	};

	const splitDiffColumns = (segments) => {
		const original = [];
		const updated = [];
		(segments ?? []).forEach((segment) => {
			if (!segment?.text) return;
			if (segment.type !== 'insert') original.push(segment);
			if (segment.type !== 'delete') updated.push(segment);
		});
		return { original, updated };
	};

	const hasMeaningfulDiff = (segments) =>
		(segments ?? []).some((segment) => segment?.type && segment.type !== 'equal');

	$: originalBodyForDiff =
		typeof draftOriginal === 'string'
			? draftOriginal
			: typeof draft?.body === 'string'
				? draft.body
				: '';
	$: diffSegments = (() => {
		if (Array.isArray(draftDiff) && draftBody === (draft?.body ?? '') && draftDiff.length) {
			return draftDiff;
		}
		return diffWords(originalBodyForDiff, draftBody ?? '');
	})();
	$: diffColumns = splitDiffColumns(diffSegments);
	$: hasToneDiff = hasMeaningfulDiff(diffSegments);
</script>

<svelte:window on:mousedown={handleClickOutside} />

{#if draft}
	<div>
		<div class="overflow-hidden rounded-md border border-neutral-100 bg-white">
			<div class="bg-white">
				<div class="px-4 py-3">
					<div class="text-sm font-semibold text-neutral-900">Drafted reply</div>
				</div>

				{#if suggestedVendors.length > 0 || vendors.length > 0}
					<div class="border-t border-neutral-100 px-4 py-2">
						<div class="relative flex items-center gap-2" bind:this={pickerEl}>
							<span class="text-xs text-neutral-500">To:</span>
							{#if currentVendorName}
								<span class="text-xs font-medium text-neutral-800">{currentVendorName}</span>
							{:else}
								<span class="text-xs text-neutral-400">No vendor selected</span>
							{/if}
							<button
								class="ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-neutral-500 hover:bg-neutral-100"
								type="button"
								on:click={() => {
									showVendorPicker = !showVendorPicker;
									vendorSearch = '';
								}}
							>
								Change
							</button>

							{#if showVendorPicker}
								<div
									class="absolute top-7 left-0 z-20 w-72 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg"
								>
									<div class="border-b border-neutral-100 px-3 py-2">
										<input
											class="w-full border-0 bg-transparent p-0 text-xs text-neutral-700 outline-none placeholder:text-neutral-400"
											placeholder="Search vendors..."
											bind:value={vendorSearch}
											autofocus
										/>
									</div>

									<div class="max-h-60 overflow-y-auto">
										{#if filteredSuggested.length > 0}
											<div class="px-3 pt-2 pb-1">
												<div
													class="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase"
												>
													Suggested
												</div>
											</div>
											{#each filteredSuggested as vendor}
												<button
													class="flex w-full flex-col px-3 py-1.5 text-left hover:bg-neutral-50"
													type="button"
													on:click={() => changeVendor(vendor)}
												>
													<div class="flex items-center gap-1.5">
														{#if vendor.email?.toLowerCase() === currentRecipientEmail?.toLowerCase()}
															<span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
														{:else}
															<span class="h-1.5 w-1.5 rounded-full bg-transparent"></span>
														{/if}
														<span class="text-xs font-medium text-neutral-900">{vendor.name}</span>
														{#if vendor.trade}
															<span class="text-xs text-neutral-400">· {vendor.trade}</span>
														{/if}
													</div>
													{#if vendor.reason}
														<div class="ml-3 text-[10px] text-neutral-400">{vendor.reason}</div>
													{/if}
												</button>
											{/each}
										{/if}

										{#if filteredAll.length > 0}
											<div class="px-3 pt-2 pb-1">
												<div
													class="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase"
												>
													All Vendors
												</div>
											</div>
											{#each filteredAll as vendor}
												<button
													class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-neutral-50"
													type="button"
													on:click={() => changeVendor(vendor)}
												>
													{#if vendor.email?.toLowerCase() === currentRecipientEmail?.toLowerCase()}
														<span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
													{:else}
														<span class="h-1.5 w-1.5 rounded-full bg-transparent"></span>
													{/if}
													<span class="text-xs font-medium text-neutral-900">{vendor.name}</span>
													{#if vendor.trade}
														<span class="text-xs text-neutral-400">· {vendor.trade}</span>
													{/if}
												</button>
											{/each}
										{/if}

										{#if filteredSuggested.length === 0 && filteredAll.length === 0}
											<div class="px-3 py-3 text-xs text-neutral-400">No vendors found.</div>
										{/if}
									</div>
								</div>
							{/if}
						</div>
					</div>
				{/if}

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
								on:click={handleApproveClick}
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

		{#if showTonePrompt}
			<div
				class="fixed inset-0 z-40 bg-neutral-900/30"
				on:click={closeTonePrompt}
				transition:fade={{ duration: 160 }}
			></div>
			<div
				class="fixed inset-0 z-50 flex items-center justify-center px-4"
				on:click={closeTonePrompt}
			>
				<div
					class="w-full max-w-4xl rounded-lg border border-neutral-200 bg-white shadow-xl"
					role="dialog"
					aria-modal="true"
					on:click|stopPropagation
					transition:scale={{ duration: 180, start: 0.96 }}
				>
					<div class="flex items-center justify-between border-b border-neutral-100 px-5 py-4">
						<div>
							<div class="text-base font-semibold text-neutral-900">Draft Tone</div>
							<div class="text-xs text-neutral-500">
								Review how the message changed before approving.
							</div>
						</div>
						<button
							type="button"
							class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
							on:click={closeTonePrompt}
							disabled={tonePromptLoading}
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
					<div class="px-5 py-4">
						<div class="grid gap-4 md:grid-cols-2">
							<div>
								<div class="text-xs font-semibold text-neutral-600">Original</div>
								<div
									class="mt-2 max-h-80 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm whitespace-pre-wrap text-neutral-700"
								>
									{#each diffColumns.original as segment}
										<span
											class={segment.type === 'delete'
												? 'rounded-sm bg-rose-100 text-rose-800'
												: ''}
										>
											{segment.text}
										</span>
									{/each}
								</div>
							</div>
							<div>
								<div class="text-xs font-semibold text-neutral-600">Current</div>
								<div
									class="mt-2 max-h-80 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm whitespace-pre-wrap text-neutral-700"
								>
									{#each diffColumns.updated as segment}
										<span
											class={segment.type === 'insert'
												? 'rounded-sm bg-emerald-100 text-emerald-800'
												: ''}
										>
											{segment.text}
										</span>
									{/each}
								</div>
							</div>
						</div>
						<div class="mt-4 text-sm text-neutral-700">
							Use this tone for similar Appfolio drafts moving forward?
						</div>
						{#if tonePromptError}
							<div class="mt-2 text-xs text-rose-600">{tonePromptError}</div>
						{/if}
					</div>
					<div class="flex items-center justify-end gap-2 border-t border-neutral-100 px-5 py-4">
						<button
							type="button"
							class="rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 transition hover:border-neutral-300"
							on:click={approveOnce}
							disabled={tonePromptLoading || isApproving}
						>
							Approve once
						</button>
						<button
							type="button"
							class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white transition hover:bg-neutral-800 disabled:opacity-60"
							on:click={approveAndSave}
							disabled={!hasToneDiff || tonePromptLoading || isApproving}
						>
							{#if tonePromptLoading}
								Saving...
							{:else}
								Approve and save
							{/if}
						</button>
					</div>
				</div>
			</div>
		{/if}
	</div>
{/if}
