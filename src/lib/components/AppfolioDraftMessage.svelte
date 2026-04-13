<script>
	// @ts-nocheck
	import { createEventDispatcher, onMount } from 'svelte';
	import { page } from '$app/stores';
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
	let policyLearningEnabled = false;
	let draftOriginal = draft?.original_body ?? null;
	let draftDiff = draft?.draft_diff ?? null;
	let showOriginalModal = false;
	const APPROVAL_KEY = 'appfolio_approved_by';
	const getApprovalStorageKey = () =>
		`${APPROVAL_KEY}:${draft?.issue_id ?? 'unknown'}:${draft?.id ?? 'draft'}`;

	// Vendor search state
	let vendorSearch = '';
	let changeButtonEl;
	let vendorChangeSeq = 0;
	let recipientEmailOverride = null;
	let vendorSaveTimeout;
	let vendorSaveInFlight = false;
	let vendorSavePending = null;

	const normalizeEmailValue = (value) => {
		const trimmed = (value ?? '').toString().trim().toLowerCase();
		return trimmed || null;
	};

	const pickTradeForGrouping = (trade, query) => {
		const raw = (trade ?? '').toString().trim();
		if (!raw) return 'Other';
		const parts = raw
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean);
		if (parts.length <= 1) return parts[0] ?? 'Other';
		const terms = (query ?? '').toString().trim().toLowerCase().split(/\s+/).filter(Boolean);
		for (const term of terms) {
			const match = parts.find((p) => p.toLowerCase().includes(term));
			if (match) return match;
		}
		return parts[0] ?? 'Other';
	};

	const uniqueVendorKey = (v) => normalizeEmailValue(v?.email) ?? v?.id ?? v?.name ?? '';

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

	$: filteredVendors = searchVendors(vendors, vendorSearch);
	$: suggestedVendors = recommendedVendors ?? [];
	$: suggestedCards = (() => {
		const list = suggestedVendors ?? [];
		const selected = normalizeEmailValue(currentRecipientEmail);
		const selectedVendor = selectedVendorForPin;

		const out = [];
		const seen = new Set();
		const push = (v) => {
			const key = uniqueVendorKey(v);
			if (!key || seen.has(key)) return;
			seen.add(key);
			out.push(v);
		};

		// If a vendor is already chosen, always show it first.
		if (selected && selectedVendor) push(selectedVendor);
		for (const v of list) {
			push(v);
			if (out.length >= 4) break;
		}
		return out.slice(0, 4);
	})();
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

	// IDs already in recommended so we don't show duplicates in "All" section
	$: suggestedIds = new Set(suggestedVendors.map((v) => v.id));

	$: filteredSuggested = suggestedVendors.filter(
		(v) => !vendorSearch || searchVendors([v], vendorSearch).length > 0
	);
	$: filteredAll = filteredVendors.filter((v) => !suggestedIds.has(v.id));
	$: searchResults = (() => {
		if (!vendorSearch?.trim()) return [];
		const out = [];
		const seen = new Set();
		for (const v of [...filteredSuggested, ...filteredAll]) {
			const key = uniqueVendorKey(v);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push(v);
		}
		return out;
	})();
	$: selectedVendorForPin = (() => {
		const selected = normalizeEmailValue(currentRecipientEmail);
		if (!selected) return null;
		return (
			[...(suggestedVendors ?? []), ...(vendors ?? [])].find(
				(v) => normalizeEmailValue(v?.email) === selected
			) ?? null
		);
	})();
	$: groupedSearchResults = (() => {
		const qTerms = vendorSearch.toString().trim().toLowerCase().split(/\s+/).filter(Boolean);
		const groups = new Map();
		const order = [];
		const selected = normalizeEmailValue(currentRecipientEmail);
		for (const v of searchResults) {
			if (selected && normalizeEmailValue(v?.email) === selected) continue;
			const trade = pickTradeForGrouping(v?.trade, vendorSearch);
			if (!groups.has(trade)) {
				groups.set(trade, []);
				order.push(trade);
			}
			groups.get(trade).push(v);
		}
		const scoreTrade = (trade) => {
			const t = trade.toLowerCase();
			let bestIndex = Infinity;
			for (const term of qTerms) {
				const idx = t.indexOf(term);
				if (idx !== -1) bestIndex = Math.min(bestIndex, idx);
			}
			return { hasMatch: bestIndex !== Infinity, bestIndex };
		};
		return order
			.slice()
			.sort((a, b) => {
				const sa = scoreTrade(a);
				const sb = scoreTrade(b);
				if (sa.hasMatch !== sb.hasMatch) return sb.hasMatch - sa.hasMatch;
				if (sa.bestIndex !== sb.bestIndex) return sa.bestIndex - sb.bestIndex;
				const la = groups.get(a)?.length ?? 0;
				const lb = groups.get(b)?.length ?? 0;
				if (la !== lb) return lb - la;
				return a.localeCompare(b);
			})
			.map((trade) => {
				const vendors = groups.get(trade) ?? [];
				vendors.sort((va, vb) => (vb?.reason ? 1 : 0) - (va?.reason ? 1 : 0));
				return { trade, vendors };
			});
	})();
	$: showVendorListScrollHint = searchResults.length > 6;

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
	});

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
		if (!policyLearningEnabled) return;
		tonePromptError = '';
		showTonePrompt = true;
	};

	const closeAutoPrompt = () => {
		if (autoPromptLoading) return;
		showAutoPrompt = false;
		autoPromptError = '';
	};

	const openAutoPrompt = () => {
		if (!policyLearningEnabled) return;
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
			return;
		}
		recipientEmailOverride = intendedEmail;
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
		if (!policyLearningEnabled) {
			await approveDraft();
			return;
		}
		openAutoPrompt();
	};

	const approveAndSave = async () => {
		if (tonePromptLoading) return;
		if (!policyLearningEnabled) {
			closeTonePrompt();
			await approveDraft();
			return;
		}
		const policy = await saveTonePolicy();
		if (!policy) return;
		closeTonePrompt();
		openAutoPrompt();
	};

	const handleApproveClick = () => {
		if (isApproving || approvedByLocal) return;
		if (!policyLearningEnabled) {
			approveDraft();
			return;
		}
		if (hasToneDiff) {
			openTonePrompt();
			return;
		}
		openAutoPrompt();
	};

	const openOriginalModal = () => {
		showOriginalModal = true;
	};

	const closeOriginalModal = () => {
		showOriginalModal = false;
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
	$: policyLearningEnabled = Boolean($page?.data?.workspace?.policy_learning_enabled);
	$: if (!policyLearningEnabled) {
		showTonePrompt = false;
		showAutoPrompt = false;
		tonePromptError = '';
		autoPromptError = '';
	}
</script>

{#if draft}
	<div>
		<div class="space-y-2">
			<div class="grid gap-3 md:grid-cols-5 md:items-stretch md:gap-3">
				{#if canPickVendor}
					<div class="md:col-span-2 md:flex md:h-[22rem] md:flex-col">
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
								class="w-full rounded-md border border-neutral-100 bg-white py-2 pr-3 pl-7 text-xs text-neutral-700 placeholder:text-neutral-400 focus:border-neutral-200 focus:ring-0 focus:outline-none"
								placeholder="Search by name or trade..."
								bind:value={vendorSearch}
							/>
						</div>

						<div class="mt-2 md:min-h-0 md:flex-1">
							{#if vendorSearch?.trim()}
								<div class="relative flex h-full flex-col">
									{#if vendorSearch?.trim() && selectedVendorForPin}
										{@const isSelected =
											selectedVendorForPin.email?.toLowerCase() ===
											currentRecipientEmail?.toLowerCase()}
										<button
											type="button"
											class={`w-full rounded-md border px-3 py-2 text-left transition ${
												isSelected
													? 'border-emerald-200 bg-emerald-50'
													: 'border-neutral-100 bg-white hover:bg-neutral-50'
											}`}
											on:click={() => changeVendor(selectedVendorForPin)}
											aria-pressed={isSelected}
										>
											<div class="flex items-start justify-between gap-2">
												<div class="min-w-0">
													<div class="truncate text-xs font-semibold text-neutral-900">
														{selectedVendorForPin.name}
													</div>
													{#if selectedVendorForPin.reason}
														<div class="mt-1 text-[10px] text-neutral-400">
															{selectedVendorForPin.reason}
														</div>
													{/if}
												</div>
												{#if isSelected}
													<span class="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500"></span>
												{/if}
											</div>
										</button>
										<div class="h-2"></div>
									{/if}

									<div
										class="max-h-64 min-h-0 flex-1 overflow-x-hidden overflow-y-auto md:max-h-none"
									>
										<div class={`space-y-2 ${showVendorListScrollHint ? 'pb-4' : ''}`}>
											{#each groupedSearchResults as group (group.trade)}
												<div class="space-y-1">
													<div class="px-1 pt-1 pb-0">
														<div class="text-xs font-semibold text-neutral-400">{group.trade}</div>
													</div>
													<div class="space-y-2">
														{#each group.vendors as vendor (uniqueVendorKey(vendor))}
															{@const isSelected =
																vendor.email?.toLowerCase() ===
																currentRecipientEmail?.toLowerCase()}
															<button
																type="button"
																disabled={!vendor?.email}
																class={`w-full rounded-md border px-3 py-2 text-left transition ${
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
																		{#if vendor.reason}
																			<div class="mt-1 text-[10px] text-neutral-400">
																				{vendor.reason}
																			</div>
																		{:else if !vendor?.email}
																			<div class="mt-1 text-[10px] text-neutral-400">No email</div>
																		{/if}
																	</div>
																	{#if isSelected}
																		<span
																			class="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500"
																		></span>
																	{/if}
																</div>
															</button>
														{/each}
													</div>
												</div>
											{/each}

											{#if groupedSearchResults.length === 0}
												<div class="py-3 text-xs text-neutral-400">No vendors found.</div>
											{/if}
										</div>
									</div>
									{#if showVendorListScrollHint}
										<div
											class="pointer-events-none absolute right-4 bottom-0 left-0 z-10 h-8 bg-gradient-to-t from-white via-white/70 to-transparent"
										></div>
									{/if}
								</div>
							{/if}

							{#if !vendorSearch?.trim() && suggestedCards.length > 0}
								<div class="space-y-2">
									{#each suggestedCards as vendor (uniqueVendorKey(vendor))}
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
													{#if vendor.reason}
														<div class="mt-1 text-[10px] text-neutral-400">{vendor.reason}</div>
													{:else if !vendor?.email}
														<div class="mt-1 text-[10px] text-neutral-400">No email</div>
													{/if}
												</div>
												{#if isSelected}
													<span class="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500"></span>
												{/if}
											</div>
										</button>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<div
					class={`overflow-hidden rounded-md border border-neutral-100 bg-white md:flex md:h-[22rem] md:flex-col ${
						canPickVendor ? 'md:col-span-3' : 'md:col-span-5'
					}`}
				>
					<div class="bg-white md:flex md:min-h-0 md:flex-1 md:flex-col">
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
								</div>
							</div>
						{/if}

						<div
							class="border-t border-neutral-100 px-4 py-3 md:min-h-0 md:flex-1 md:overflow-auto"
						>
							<textarea
								class="w-full resize-none border-0 bg-transparent p-0 text-sm text-neutral-700 ring-0 outline-none focus:ring-0 focus:outline-none"
								rows="2"
								bind:value={draftBody}
								bind:this={textareaEl}
								on:input={queueSave}
								{readonly}
							></textarea>
						</div>

						<div class="border-t border-neutral-100 px-4 py-3">
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-3">
									<button
										type="button"
										class="inline-flex items-center gap-2 text-xs text-neutral-500 transition hover:text-neutral-900 disabled:opacity-50"
										on:click={openOriginalModal}
										disabled={!originalBodyForDiff && !draftBody}
									>
										View original
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
			show={showOriginalModal}
			title="Draft changes"
			{diffColumns}
			onClose={closeOriginalModal}
			onSecondary={closeOriginalModal}
			secondaryLabel="Close"
			primaryLabel={null}
			secondaryDisabled={false}
			primaryDisabled={true}
		/>

		{#if policyLearningEnabled}
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
		{/if}
	</div>
{/if}
