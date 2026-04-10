<script>
	// @ts-nocheck
	import { createEventDispatcher, onMount, tick } from 'svelte';
	import TonePromptModal from '$lib/components/TonePromptModal.svelte';
	import AutoPromptModal from '$lib/components/AutoPromptModal.svelte';
	import { agentToasts } from '$lib/stores/agentToasts';
	import { applyPolicyInsert } from '$lib/stores/policiesCache';
	import { diffWords } from '$lib/utils/textDiff';
	import { searchVendors } from '$lib/utils/vendorSearch';
	const dispatch = createEventDispatcher();

	export let draft = null;
	export let approvedBy = null;
	export let vendors = [];
	export let recommendedVendors = [];
	export let readonly = false;
	export let issueName = '';

	let draftBody = draft?.body ?? '';
	let saveTimeout;
	let lastMessageKey = draft?.id ?? null;
	let textareaEl;
	let isApproving = false;
	let approvedByLocal = approvedBy ?? null;
	let showTonePrompt = false;
	let tonePromptLoading = false;
	let tonePromptError = '';
	let showAutoPrompt = false;
	let autoPromptLoading = false;
	let autoPromptError = '';
	let draftOriginal = draft?.original_body ?? null;
	let draftDiff = draft?.draft_diff ?? null;
	let showOriginal = false;
	const APPROVAL_KEY = 'appfolio_approved_by';
	const getApprovalStorageKey = () =>
		`${APPROVAL_KEY}:${draft?.issue_id ?? 'unknown'}:${draft?.id ?? 'draft'}`;

	// Vendor picker state
	let showVendorPicker = false;
	let vendorSearch = '';
	let pickerEl;
	let changeButtonEl;
	let dropdownEl;
	// Anchor element for the floating vendor list.
	// (Historically this was the "Change" button; now it's the search input.)
	let pickerStyle = '';
	let vendorChangeSeq = 0;
	let recipientEmailOverride = null;
	let vendorSaveTimeout;
	let vendorSaveInFlight = false;
	let vendorSavePending = null;

	const normalizeEmailValue = (value) => {
		const trimmed = (value ?? '').toString().trim().toLowerCase();
		return trimmed || null;
	};

	const getVendorGreetingName = (name) => {
		const trimmed = name?.trim();
		if (!trimmed) return null;
		if (trimmed.includes(',')) {
			const afterComma = trimmed.split(',')[1]?.trim();
			if (afterComma) return afterComma.split(/\s+/)[0] ?? null;
		}
		const lowered = trimmed.toLowerCase();
		const companyIndicators = [
			'llc',
			'inc',
			'company',
			'co',
			'corp',
			'corporation',
			'group',
			'partners',
			'brothers',
			'bros',
			'services',
			'service',
			'construction',
			'builders',
			'plumbing',
			'electrical',
			'electric',
			'hvac',
			'heating',
			'cooling',
			'air',
			'conditioning',
			'maintenance',
			'repair',
			'roofing',
			'landscaping',
			'cleaning',
			'painting'
		];
		if (companyIndicators.some((indicator) => lowered.includes(indicator))) {
			return trimmed;
		}
		const firstWord = trimmed.split(/\s+/)[0];
		return firstWord || trimmed;
	};

	const updateDraftGreeting = (body, greetingName) => {
		if (!greetingName) return body ?? '';
		const lines = String(body ?? '').split('\n');
		let replaced = false;
		const nextLines = lines.map((line) => {
			if (replaced) return line;
			const trimmed = line.trim();
			if (trimmed.toLowerCase().startsWith('hi,')) {
				replaced = true;
				return `Hi, ${greetingName}`;
			}
			return line;
		});
		if (replaced) return nextLines.join('\n');
		const remaining = [...nextLines];
		while (remaining.length && remaining[0].trim() === '') remaining.shift();
		return [`Hi, ${greetingName}`, '', ...remaining].join('\n');
	};

	const updatePickerPosition = () => {
		if (!changeButtonEl) return;
		const rect = changeButtonEl.getBoundingClientRect();
		pickerStyle = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:50;`;
	};

	const handlePickerReposition = () => {
		if (!showVendorPicker) return;
		updatePickerPosition();
	};

	$: filteredVendors = searchVendors(vendors, vendorSearch);
	$: suggestedVendors = recommendedVendors ?? [];
	$: suggestedCards = (suggestedVendors ?? []).slice(0, 4);
	$: normalizedIssueName = (issueName ?? '').toString();
	$: isScheduleIssue = /^schedule\s+/i.test(normalizedIssueName);
	$: isKnownVendorRecipient = Boolean(
		currentRecipientEmail &&
		[...(vendors ?? []), ...(suggestedVendors ?? [])].some(
			(v) =>
				normalizeEmailValue(v?.email) &&
				normalizeEmailValue(v.email) === normalizeEmailValue(currentRecipientEmail)
		)
	);
	$: showVendorHeader = isScheduleIssue || isKnownVendorRecipient;
	$: showVendorCards = isScheduleIssue;
	$: if (!isScheduleIssue && showVendorPicker) {
		closeVendorPicker();
	}
	$: if (showVendorPicker && !vendorSearch?.trim()) {
		closeVendorPicker();
	}

	// IDs already in recommended so we don't show duplicates in "All" section
	$: suggestedIds = new Set(suggestedVendors.map((v) => v.id));

	$: filteredSuggested = suggestedVendors.filter(
		(v) => !vendorSearch || searchVendors([v], vendorSearch).length > 0
	);
	$: filteredAll = filteredVendors.filter((v) => !suggestedIds.has(v.id));

	// Current recipient display name
	$: serverRecipientEmail = draft?.recipient_email ?? null;
	$: currentRecipientEmail = recipientEmailOverride ?? serverRecipientEmail;
	$: if (
		recipientEmailOverride &&
		normalizeEmailValue(serverRecipientEmail) === normalizeEmailValue(recipientEmailOverride)
	) {
		recipientEmailOverride = null;
	}
	$: currentVendorName = currentRecipientEmail
		? (vendors.find((v) => v.email?.toLowerCase() === currentRecipientEmail?.toLowerCase())?.name ??
			recommendedVendors.find(
				(v) => v.email?.toLowerCase() === currentRecipientEmail?.toLowerCase()
			)?.name ??
			currentRecipientEmail)
		: null;
	$: canPickVendor =
		!readonly &&
		isScheduleIssue &&
		((vendors?.length ?? 0) > 0 || (suggestedVendors?.length ?? 0) > 0);

	$: if (draft && draft.id !== lastMessageKey) {
		lastMessageKey = draft.id;
		draftBody = draft.body ?? '';
		draftOriginal = draft?.original_body ?? null;
		draftDiff = draft?.draft_diff ?? null;
		approvedByLocal = approvedBy ?? null;
		recipientEmailOverride = null;
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
		if (approvedBy) {
			const stored = window.localStorage.getItem(getApprovalStorageKey());
			if (stored && !approvedByLocal) {
				approvedByLocal = stored;
			}
		}
		window.addEventListener('scroll', handlePickerReposition, true);
		window.addEventListener('resize', handlePickerReposition);
		return () => {
			window.removeEventListener('scroll', handlePickerReposition, true);
			window.removeEventListener('resize', handlePickerReposition);
		};
	});

	const openVendorPicker = async () => {
		if (readonly) return;
		if (!isScheduleIssue) return;
		if (!vendorSearch?.trim()) return;
		if (showVendorPicker) return;
		showVendorPicker = true;
		updatePickerPosition();
		await tick();
	};

	const closeVendorPicker = () => {
		showVendorPicker = false;
	};

	const handleVendorSearchInput = () => {
		// Only open results once the user starts typing.
		if (!vendorSearch?.trim()) {
			closeVendorPicker();
			return;
		}
		openVendorPicker();
	};

	const flushVendorSave = async () => {
		if (vendorSaveInFlight) return;
		const pending = vendorSavePending;
		if (!pending) return;
		vendorSavePending = null;
		vendorSaveInFlight = true;
		try {
			const response = await fetch('/api/email-drafts', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(pending.body)
			});
			if (pending.seq !== vendorChangeSeq) return;
			if (response.ok) return;
			recipientEmailOverride = pending.prevEmail ?? null;
			draftBody = pending.prevBody;
			showToast('Failed to update vendor.');
		} catch {
			if (pending.seq !== vendorChangeSeq) return;
			recipientEmailOverride = pending.prevEmail ?? null;
			draftBody = pending.prevBody;
			showToast('Failed to update vendor.');
		} finally {
			vendorSaveInFlight = false;
			if (vendorSavePending) {
				queueMicrotask(flushVendorSave);
			}
		}
	};

	const showToast = (message, id) => {
		agentToasts.upsert({
			id: id ?? `appfolio-toast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
			message,
			stage: 'done'
		});
	};

	const saveDraft = async () => {
		if (readonly) return;
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

	const closeAutoPrompt = () => {
		if (autoPromptLoading) return;
		showAutoPrompt = false;
		autoPromptError = '';
	};

	const openAutoPrompt = () => {
		autoPromptError = '';
		showAutoPrompt = true;
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

	const saveAutoPolicy = async () => {
		if (!draft?.issue_id) {
			autoPromptError = 'Draft is missing an issue.';
			return null;
		}
		if (!draftBody?.trim()) {
			autoPromptError = 'Message template is empty.';
			return null;
		}
		autoPromptLoading = true;
		autoPromptError = '';
		try {
			const response = await fetch('/api/policies/auto', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					issue_id: draft.issue_id,
					template: draftBody
				})
			});
			const result = await response.json().catch(() => null);
			if (!response.ok) {
				throw new Error(result?.error ?? 'Unable to save auto policy.');
			}
			if (result?.policy) {
				applyPolicyInsert(result.policy);
			}
			return result?.policy ?? null;
		} catch (err) {
			autoPromptError = err?.message ?? 'Unable to save auto policy.';
			return null;
		} finally {
			autoPromptLoading = false;
		}
	};

	const changeVendor = async (vendor) => {
		if (readonly) return;
		if (!isScheduleIssue) return;
		if (!draft?.issue_id && !draft?.message_id) return;
		if (!vendor?.email) {
			showToast('Selected vendor is missing an email address.');
			return;
		}
		const prevEmail = currentRecipientEmail;
		const seq = (vendorChangeSeq += 1);
		const intendedEmail = vendor.email;
		if (normalizeEmailValue(prevEmail) === normalizeEmailValue(intendedEmail)) {
			showVendorPicker = false;
			vendorSearch = '';
			return;
		}
		recipientEmailOverride = intendedEmail;
		closeVendorPicker();
		vendorSearch = '';
		const prevBody = draftBody;
		const greetingName = getVendorGreetingName(vendor.name);
		const nextBody = updateDraftGreeting(draftBody, greetingName);
		draftBody = nextBody;
		const draftMessageId = draft?.message_id ?? null;
		const draftIssueId = draft?.issue_id ?? null;
		const requestBody = draftMessageId
			? {
					message_id: draftMessageId,
					recipient_emails: [intendedEmail],
					channel: 'appfolio',
					...(nextBody !== prevBody ? { body: nextBody } : {})
				}
			: {
					issue_id: draftIssueId,
					recipient_emails: [intendedEmail],
					channel: 'appfolio',
					...(nextBody !== prevBody ? { body: nextBody } : {})
				};

		vendorSavePending = {
			seq,
			prevEmail,
			prevBody,
			body: requestBody
		};
		if (vendorSaveTimeout) clearTimeout(vendorSaveTimeout);
		vendorSaveTimeout = setTimeout(() => {
			flushVendorSave();
		}, 300);
	};

	const approveDraft = async () => {
		if (readonly) return;
		if (!draft?.issue_id) return;
		if (isApproving) return;
		isApproving = true;
		dispatch('approvalStarted', { issueId: draft.issue_id });
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
			const payload = await response.json().catch(() => null);
			if (!response.ok) {
				const reason = payload?.error ?? `HTTP ${response.status}`;
				console.error('[AppfolioDraft] approve failed:', reason, payload);
				throw new Error(reason);
			}
			approvedByLocal = payload?.approved_by ?? approvedByLocal ?? 'You';
			const assigneeName = payload?.assignee_name ?? null;
			dispatch('draftApproved', {
				approvedDraft: draft,
				followupDraft: payload?.followup_draft ?? null
			});
			dispatch('assigneeUpdated', {
				issueId: payload?.issue_id ?? draft.issue_id,
				parentIssueId: payload?.parent_issue_id ?? null,
				assigneeId: payload?.assignee_id ?? null,
				assigneeName
			});
			showToast('Draft approved.');
		} catch (err) {
			console.error('[AppfolioDraft] approve error:', err);
			showToast(`Approval failed: ${err?.message ?? 'unknown error'}`);
		} finally {
			isApproving = false;
		}
	};

	const approveOnce = async () => {
		closeTonePrompt();
		openAutoPrompt();
	};

	const approveAndSave = async () => {
		if (tonePromptLoading) return;
		const policy = await saveTonePolicy();
		if (!policy) return;
		closeTonePrompt();
		openAutoPrompt();
	};

	const handleApproveClick = () => {
		if (isApproving || approvedByLocal) return;
		if (hasToneDiff) {
			openTonePrompt();
			return;
		}
		openAutoPrompt();
	};

	const requireApproval = async () => {
		closeAutoPrompt();
		await approveDraft();
	};

	const automateReply = async () => {
		if (autoPromptLoading) return;
		const policy = await saveAutoPolicy();
		if (!policy) return;
		closeAutoPrompt();
		await approveDraft();
	};

	const queueSave = () => {
		if (readonly) return;
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
		if (showVendorPicker && !pickerEl?.contains(e.target) && !dropdownEl?.contains(e.target)) {
			closeVendorPicker();
		}
	};

	const handleKeydown = (e) => {
		if (showVendorPicker && e.key === 'Escape') {
			e.stopPropagation();
			closeVendorPicker();
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

<svelte:window on:mousedown={handleClickOutside} on:keydown|capture={handleKeydown} />

{#if draft}
	<div>
		<div class="space-y-2" bind:this={pickerEl}>
			<div class="grid gap-3 md:grid-cols-3 md:items-start md:gap-4">
				{#if canPickVendor}
					<div class="md:col-span-1">
						<div class="relative w-full">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="12"
								height="12"
								fill="currentColor"
								class="bi bi-search pointer-events-none absolute top-1/2 left-2.5 h-3 w-3 -translate-y-1/2 text-neutral-400"
								viewBox="0 0 16 16"
								aria-hidden="true"
							>
								<path
									d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"
								/>
							</svg>
							<input
								bind:this={changeButtonEl}
								class="w-full rounded-md border border-neutral-100 bg-white py-2 pr-10 pl-7 text-xs text-neutral-700 placeholder:text-neutral-400 focus:border-neutral-200 focus:ring-0 focus:outline-none"
								placeholder="Search by name or trade..."
								bind:value={vendorSearch}
								on:input={handleVendorSearchInput}
							/>
							{#if vendorSearch}
								<button
									type="button"
									class="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[10px] font-semibold text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
									on:click={() => {
										vendorSearch = '';
										closeVendorPicker();
										changeButtonEl?.focus();
									}}
									aria-label="Clear search"
								>
									Clear
								</button>
							{/if}
						</div>

						{#if suggestedCards.length > 0}
							<div class="mt-2 grid grid-cols-2 gap-2 md:grid-cols-1">
								{#each suggestedCards as vendor (vendor.id)}
									{@const isSelected =
										vendor.email?.toLowerCase() === currentRecipientEmail?.toLowerCase()}
									<button
										type="button"
										disabled={!vendor?.email}
										class={`w-full min-w-0 rounded-md border px-3 py-2 text-left transition ${
											!vendor?.email
												? 'cursor-not-allowed border-neutral-100 bg-neutral-50 opacity-60'
												: isSelected
													? 'border-emerald-200 bg-emerald-50'
													: 'border-neutral-100 bg-white hover:bg-neutral-50'
										}`}
										on:click={() => {
											if (!vendor?.email) return;
											changeVendor(vendor);
										}}
										aria-pressed={isSelected}
									>
										<div class="flex items-start justify-between gap-2">
											<div class="min-w-0">
												<div class="truncate text-xs font-semibold text-neutral-900">
													{vendor.name}
												</div>
												{#if vendor.trade}
													<div class="truncate text-[11px] text-neutral-500">
														{vendor.trade}
													</div>
												{/if}
											</div>
											{#if isSelected}
												<span class="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500"></span>
											{/if}
										</div>
										{#if vendor.reason}
											<div class="mt-1 text-[10px] text-neutral-400">{vendor.reason}</div>
										{:else if !vendor?.email}
											<div class="mt-1 text-[10px] text-neutral-400">No email</div>
										{/if}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<div
					class={`overflow-hidden rounded-md border border-neutral-100 bg-white ${
						canPickVendor ? 'md:col-span-2' : 'md:col-span-3'
					}`}
				>
					<div class="bg-white">
						{#if currentRecipientEmail || suggestedVendors.length > 0 || vendors.length > 0}
							<div class="px-4 py-2">
								<div class="relative flex items-center gap-2">
									{#if showVendorHeader}
										<span class="text-xs text-neutral-500">Vendor:</span>
										{#if currentVendorName}
											<span class="text-xs font-medium text-neutral-800">{currentVendorName}</span>
										{:else}
											<span class="text-xs text-neutral-400">Unassigned</span>
										{/if}
									{:else}
										<span class="text-xs text-neutral-500">To:</span>
										<span class="text-xs font-medium text-neutral-800">Tenant</span>
									{/if}
									{#if showVendorPicker && !readonly}
										<div
											bind:this={dropdownEl}
											class="w-72 overflow-hidden rounded-md border border-neutral-100 bg-white"
											style={pickerStyle}
										>
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
																<span class="text-xs font-medium text-neutral-900"
																	>{vendor.name}</span
																>
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
															<span class="text-xs font-medium text-neutral-900">{vendor.name}</span
															>
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
								{readonly}
							></textarea>
							{#if showOriginal}
								<div class="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3">
									<div class="grid gap-4 md:grid-cols-2">
										<div>
											<div class="text-xs font-semibold text-neutral-600">Original</div>
											<div class="mt-2 text-sm whitespace-pre-wrap text-neutral-700">
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
											<div class="mt-2 text-sm whitespace-pre-wrap text-neutral-700">
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
								</div>
							{/if}
							<div class="mt-3 flex items-center justify-between">
								<div class="flex items-center gap-3">
									<button
										type="button"
										class="inline-flex items-center gap-2 text-xs text-neutral-500 transition hover:text-neutral-900 disabled:opacity-50"
										on:click={() => (showOriginal = !showOriginal)}
										disabled={!originalBodyForDiff && !draftBody}
									>
										{showOriginal ? 'Hide original' : 'View original'}
									</button>
								</div>
								{#if approvedByLocal}
									<span class="text-xs font-semibold text-emerald-700">
										Approved by {approvedByLocal}
									</span>
								{:else if !readonly}
									<button
										class="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-50"
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
			</div>
		</div>

		<TonePromptModal
			show={showTonePrompt}
			{diffColumns}
			errorMessage={tonePromptError}
			onClose={closeTonePrompt}
			onSecondary={approveOnce}
			onPrimary={approveAndSave}
			isLoading={tonePromptLoading}
			secondaryDisabled={tonePromptLoading || isApproving}
			primaryDisabled={!hasToneDiff || tonePromptLoading || isApproving}
		/>
		<AutoPromptModal
			show={showAutoPrompt}
			template={draftBody}
			errorMessage={autoPromptError}
			onClose={closeAutoPrompt}
			onSecondary={requireApproval}
			onPrimary={automateReply}
			isLoading={autoPromptLoading}
			secondaryDisabled={autoPromptLoading || isApproving}
			primaryDisabled={autoPromptLoading || isApproving}
		/>
	</div>
{/if}
