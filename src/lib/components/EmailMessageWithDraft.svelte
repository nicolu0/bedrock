<script>
	// @ts-nocheck
	import { onDestroy, createEventDispatcher } from 'svelte';
	import { agentToasts } from '$lib/stores/agentToasts';
	import { applyPolicyInsert } from '$lib/stores/policiesCache';
	import { diffWords } from '$lib/utils/textDiff';
	const dispatch = createEventDispatcher();

	export let message;
	export let draft = null;
	export let vendors = [];
	export let people = [];

	let draftBody = draft?.body ?? '';
	let saveTimeout;
	let lastMessageKey = draft?.message_id ?? draft?.id ?? null;
	let textareaEl;
	let isSending = false;
	let isSent = false;
	let sentMessage = null;
	let toastMessage = '';
	let isExpanded = Boolean(draft);
	let isQuotedExpanded = false;
	let isSentQuotedExpanded = false;
	let showOriginal = false;
	let showTonePrompt = false;
	let tonePromptLoading = false;
	let tonePromptError = '';
	let draftOriginal = draft?.original_body ?? null;
	let draftDiff = draft?.draft_diff ?? null;
	let messageParts = { main: '', quoted: '' };
	let sentParts = { main: '', quoted: '' };
	let showVendorDropdown = false;
	let vendorSearch = '';

	const normalizeRecipientList = (value) => {
		if (!value) return [];
		if (Array.isArray(value)) {
			return value.map((email) => String(email ?? '').trim()).filter(Boolean);
		}
		if (typeof value === 'string') {
			return value
				.split(',')
				.map((email) => email.trim())
				.filter(Boolean);
		}
		return [];
	};

	let localRecipientEmails = normalizeRecipientList(
		draft?.recipient_emails ?? draft?.recipient_email
	);
	let recipients = localRecipientEmails.map((email) => ({ email }));

	const setDraftRecipients = (emails) => {
		const normalized = normalizeRecipientList(emails);
		localRecipientEmails = normalized;
		recipients = normalized.map((email) => ({ email }));
		draft = {
			...draft,
			recipient_emails: normalized.length ? normalized : null,
			recipient_email: normalized[0] ?? null
		};
		return normalized;
	};

	const persistDraftRecipients = async (emails) => {
		if (!draft?.message_id && !draft?.issue_id) return;
		try {
			await fetch('/api/email-drafts', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					draft.message_id
						? { message_id: draft.message_id, recipient_emails: emails }
						: { issue_id: draft.issue_id, recipient_emails: emails }
				)
			});
		} catch {
			// ignore recipient update failures
		}
	};

	$: recipientString = recipients.map((r) => r.email).join(', ');

	$: contactOptions = (people ?? []).length ? people : vendors;

	$: filteredPeople = (contactOptions ?? []).filter(
		(person) =>
			person.name.toLowerCase().includes(vendorSearch.toLowerCase()) ||
			person.email.toLowerCase().includes(vendorSearch.toLowerCase())
	);

	const handleWindowClick = () => {
		showVendorDropdown = false;
	};

	onDestroy(() => {});

	const isRecipient = (email) => localRecipientEmails.some((item) => item === email);

	const addPerson = (person) => {
		if (!isRecipient(person.email)) {
			const nextRecipients = setDraftRecipients([...recipients.map((r) => r.email), person.email]);
			persistDraftRecipients(nextRecipients);
		}
	};

	const removeRecipientByEmail = (email) => {
		const updated = recipients.filter((r) => r.email !== email).map((r) => r.email);
		const nextRecipients = setDraftRecipients(updated);
		persistDraftRecipients(nextRecipients);
	};

	const togglePerson = (person) => {
		if (isRecipient(person.email)) {
			removeRecipientByEmail(person.email);
		} else {
			addPerson(person);
		}
	};

	const removeRecipient = (idx) => {
		const updated = recipients.filter((_, i) => i !== idx).map((r) => r.email);
		const nextRecipients = setDraftRecipients(updated);
		persistDraftRecipients(nextRecipients);
	};

	$: if (draft && (draft.message_id ?? draft.id) !== lastMessageKey) {
		lastMessageKey = draft.message_id ?? draft.id;
		draftBody = draft.body ?? '';
		draftOriginal = draft?.original_body ?? null;
		draftDiff = draft?.draft_diff ?? null;
		localRecipientEmails = normalizeRecipientList(
			draft?.recipient_emails ?? draft?.recipient_email
		);
		recipients = localRecipientEmails.map((email) => ({ email }));
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

	$: if (draft) {
		isExpanded = true;
	}

	$: if (!draft && message?._ui?.expanded && !isExpanded) {
		isExpanded = true;
	}

	$: if (!isExpanded) {
		isQuotedExpanded = false;
		isSentQuotedExpanded = false;
	}

	const showToast = (message, id) => {
		agentToasts.upsert({
			id: id ?? `email-toast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
			message,
			stage: 'done'
		});
	};

	const buildOptimisticMessage = ({ tempId, issueId, subject, body }) => ({
		id: tempId,
		issue_id: issueId ?? null,
		message: body ?? '',
		sender: 'unknown',
		subject: subject ?? '',
		timestamp: new Date().toISOString(),
		direction: 'outbound',
		channel: 'gmail',
		_ui: { expanded: true }
	});

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

	const handleSendClick = () => {
		if (!draft?.message_id && !draft?.issue_id) return;
		if (isSending || isSent) return;
		openTonePrompt();
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

	const sendDraft = async () => {
		if (!draft?.message_id && !draft?.issue_id) return;
		const effectiveRecipients = recipients.map((r) => r.email).filter(Boolean);
		if (!draft?.sender_email || !effectiveRecipients.length) {
			showToast('Draft needs sender and recipient email.');
			return;
		}
		if (isSending || isSent) return;
		const tempId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const optimisticMessage = buildOptimisticMessage({
			tempId,
			issueId: draft.issue_id ?? null,
			subject: draft.subject,
			body: draftBody
		});
		isExpanded = true;
		isSent = true;
		sentMessage = optimisticMessage;
		dispatch('sent', {
			status: 'optimistic',
			message: optimisticMessage,
			tempId,
			issueId: draft.issue_id ?? null,
			draftKey: draft.message_id ?? draft.id,
			draft
		});
		showToast(`Email sent to ${effectiveRecipients.join(', ')}`);
		try {
			isSending = true;
			const response = await fetch('/api/email-drafts/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					draft.message_id
						? { message_id: draft.message_id }
						: { issue_id: draft.issue_id, recipient_emails: effectiveRecipients }
				)
			});
			if (!response.ok) {
				throw new Error('send failed');
			}
			const payload = await response.json().catch(() => null);
			const confirmedMessage = payload?.message ?? null;
			if (confirmedMessage) {
				sentMessage = confirmedMessage;
			}
			dispatch('sent', {
				status: 'confirmed',
				message: confirmedMessage,
				tempId,
				issueId: draft.issue_id ?? null,
				draftKey: draft.message_id ?? draft.id,
				draft
			});
		} catch {
			isSent = false;
			sentMessage = null;
			showToast('Email failed to send.');
			dispatch('sent', {
				status: 'error',
				tempId,
				issueId: draft.issue_id ?? null,
				draftKey: draft.message_id ?? draft.id,
				draft
			});
		} finally {
			isSending = false;
		}
	};

	const sendOnce = async () => {
		closeTonePrompt();
		await sendDraft();
	};

	const approveAndSend = async () => {
		if (tonePromptLoading) return;
		const policy = await saveTonePolicy();
		if (!policy) return;
		closeTonePrompt();
		await sendDraft();
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

	const splitEmailBody = (body) => {
		if (!body) return { main: '', quoted: '' };
		const text = String(body);
		const separators = [
			/^On\s.+wrote:\s*$/m,
			/^From:\s.+$/m,
			/^Sent:\s.+$/m,
			/^To:\s.+$/m,
			/^Subject:\s.+$/m,
			/^-----Original Message-----$/m,
			/^_{2,}$/m
		];
		const quotedLineMatch = text.match(/^(>.*)$/m);
		const separatorMatch = separators.map((regex) => text.match(regex)).find(Boolean);
		const firstCut = [quotedLineMatch, separatorMatch]
			.filter(Boolean)
			.map((match) => match.index)
			.reduce((min, idx) => Math.min(min, idx), text.length);
		const main = text.slice(0, firstCut).trimEnd();
		const quoted = text.slice(firstCut).trim();
		if (!quoted || quoted === main) return { main: text.trimEnd(), quoted: '' };
		return { main: main || text.trimEnd(), quoted };
	};

	const toPreview = (body) => {
		if (!body) return '';
		return String(body).replace(/\s+/g, ' ').trim();
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

	const formatSenderLabel = (message) => {
		if (message?.direction === 'outbound') return 'You';
		const sender = message?.sender;
		if (sender === 'unknown') {
			const senderEmail = message?.metadata?.sender_email ?? message?.sender_email ?? '';
			return senderEmail || 'Unknown';
		}
		if (!sender) return 'Unknown';
		if (sender === 'tenant') return 'Tenant';
		if (sender === 'agent') return 'Bedrock Ops';
		return sender;
	};

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

	$: messageParts = splitEmailBody(message?.message ?? '');
	$: sentParts = splitEmailBody(sentMessage?.message ?? '');
</script>

<svelte:window on:click={handleWindowClick} />

<div class="overflow-hidden rounded-md border border-neutral-100 bg-white">
	{#if !draft}
		<button
			type="button"
			class={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition ${
				!isExpanded ? 'hover:bg-neutral-50' : ''
			}`}
			on:click={() => (isExpanded = !isExpanded)}
			aria-expanded={isExpanded}
		>
			<div class="min-w-0">
				<div class="flex min-w-0 items-baseline gap-3">
					<span class="shrink-0 font-semibold text-neutral-900">
						{formatSenderLabel(message)}
					</span>
					{#if !isExpanded}
						<span class="truncate text-sm text-neutral-600">
							{toPreview(messageParts.main || message?.message)}
						</span>
					{/if}
				</div>
			</div>
			<span class="shrink-0 text-xs text-neutral-400">{message.timestampLabel}</span>
		</button>
		{#if isExpanded}
			<div class="px-4 pb-4 text-sm text-neutral-700">
				<div class="break-words whitespace-pre-wrap">{messageParts.main}</div>
				{#if messageParts.quoted}
					<div class="mt-4">
						<button
							type="button"
							class="inline-flex h-4 w-4 items-center justify-center rounded-sm text-neutral-500 transition hover:bg-neutral-100"
							on:click={() => (isQuotedExpanded = !isQuotedExpanded)}
							aria-expanded={isQuotedExpanded}
							aria-label={isQuotedExpanded ? 'Hide quoted text' : 'Show quoted text'}
						>
							<span class="flex items-center gap-0.5" aria-hidden="true">
								<span class="h-0.5 w-0.5 rounded-full bg-neutral-400"></span>
								<span class="h-0.5 w-0.5 rounded-full bg-neutral-400"></span>
								<span class="h-0.5 w-0.5 rounded-full bg-neutral-400"></span>
							</span>
						</button>
						{#if isQuotedExpanded}
							<div class="mt-3 border-l-2 border-neutral-200 pl-4 text-neutral-600">
								<div class="break-words whitespace-pre-wrap">{messageParts.quoted}</div>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	{/if}
	{#if draft && !isSent}
		<div class="bg-white">
			<div class="px-4 py-3">
				<div class="flex flex-wrap items-center gap-1.5">
					<span class="shrink-0 text-sm font-semibold text-neutral-900">To</span>
					{#each recipients as recipient, i}
						<span
							class="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-2.5 py-0.5 text-neutral-700"
						>
							{recipient.email}
							<button
								type="button"
								class="text-neutral-400 hover:text-neutral-600"
								on:click={() => removeRecipient(i)}
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="12"
									height="12"
									viewBox="0 0 16 16"
									fill="currentColor"
								>
									<path
										d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"
									/>
								</svg>
							</button>
						</span>
					{/each}
					<div class="relative ml-auto">
						<button
							type="button"
							class="inline-flex h-6 w-6 items-center justify-center rounded bg-neutral-100 text-neutral-500 transition hover:bg-neutral-200"
							on:click|stopPropagation={() => {
								showVendorDropdown = !showVendorDropdown;
								vendorSearch = '';
							}}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="12"
								height="12"
								viewBox="0 0 16 16"
								fill="currentColor"
							>
								<path
									d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"
								/>
							</svg>
						</button>
						{#if showVendorDropdown}
							<div
								class="absolute top-full right-0 z-20 mt-1 w-56 rounded-md border border-neutral-200 bg-white shadow-md"
								on:click|stopPropagation
							>
								<div class="border-b border-neutral-100 px-2 py-1.5">
									<input
										type="text"
										class="w-full border-0 bg-transparent text-xs ring-0 outline-none placeholder:text-neutral-400 focus:ring-0"
										placeholder="Search people..."
										bind:value={vendorSearch}
										on:click|stopPropagation
									/>
								</div>
								<div class="max-h-40 overflow-y-auto">
									{#each filteredPeople as person}
										<button
											type="button"
											class="flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-neutral-50"
											on:click={() => togglePerson(person)}
										>
											<span
												class="mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded border border-neutral-200"
											>
												{#if isRecipient(person.email)}
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="10"
														height="10"
														viewBox="0 0 16 16"
														fill="currentColor"
													>
														<path
															d="M6.173 13.414 1.757 9l1.414-1.414 3.002 3.002 6.65-6.65L14.237 5z"
														/>
													</svg>
												{/if}
											</span>
											<span class="flex flex-col items-start">
												<span class="font-medium text-neutral-800">{person.name}</span>
												<span class="text-neutral-400">{person.email}</span>
											</span>
										</button>
									{:else}
										<p class="px-3 py-2 text-xs text-neutral-400">No people found</p>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				</div>
			</div>
			<div class="border-t border-neutral-100 px-4 py-3">
				<textarea
					class="w-full resize-none border-0 bg-transparent p-0 text-sm text-neutral-700 ring-0 outline-none focus:ring-0 focus:outline-none"
					rows="2"
					bind:value={draftBody}
					bind:this={textareaEl}
					on:input={queueSave}
				/>
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
					<button
						class="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-3 py-1.5 text-white transition hover:bg-neutral-800 disabled:opacity-50"
						type="button"
						on:click={handleSendClick}
						disabled={isSending}
					>
						{#if isSending}
							<span class="text-[10px] font-semibold">...</span>
						{:else}
							<span class="text-xs font-semibold">Send</span>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="18"
								height="18"
								fill="currentColor"
								viewBox="0 0 16 16"
							>
								<path
									d="M8 12a.5.5 0 0 0 .5-.5V4.707l2.147 2.147a.5.5 0 0 0 .707-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 4.707V11.5A.5.5 0 0 0 8 12z"
								/>
							</svg>
						{/if}
					</button>
				</div>
			</div>
		</div>
	{/if}
	{#if sentMessage}
		<div class="bg-white">
			<button
				type="button"
				class={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition ${
					!isExpanded ? 'hover:bg-neutral-50' : ''
				}`}
				on:click={() => (isExpanded = !isExpanded)}
				aria-expanded={isExpanded}
			>
				<div class="min-w-0">
					<div class="flex min-w-0 items-baseline gap-3">
						<span class="shrink-0 font-semibold text-neutral-900">
							{formatSenderLabel(sentMessage ?? message)}
						</span>
						{#if !isExpanded}
							<span class="truncate text-sm text-neutral-600">
								{toPreview(sentParts.main || sentMessage?.message)}
							</span>
						{/if}
					</div>
				</div>
				<span class="shrink-0 text-xs text-neutral-400">{message.timestampLabel}</span>
			</button>
			{#if isExpanded}
				<div class="px-4 pb-4 text-sm text-neutral-700">
					<div class="break-words whitespace-pre-wrap">{sentParts.main}</div>
					{#if sentParts.quoted}
						<div class="mt-4">
							<button
								type="button"
								class="inline-flex h-4 w-4 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100"
								on:click={() => (isSentQuotedExpanded = !isSentQuotedExpanded)}
								aria-expanded={isSentQuotedExpanded}
								aria-label={isSentQuotedExpanded ? 'Hide quoted text' : 'Show quoted text'}
							>
								<span class="flex items-center gap-1" aria-hidden="true">
									<span class="h-0.5 w-0.5 rounded-full bg-neutral-400"></span>
									<span class="h-0.5 w-0.5 rounded-full bg-neutral-400"></span>
									<span class="h-0.5 w-0.5 rounded-full bg-neutral-400"></span>
								</span>
							</button>
							{#if isSentQuotedExpanded}
								<div class="mt-3 border-l-2 border-neutral-200 pl-4 text-neutral-600">
									<div class="break-words whitespace-pre-wrap">{sentParts.quoted}</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if showTonePrompt}
	<div class="fixed inset-0 z-40 bg-neutral-900/30" on:click={closeTonePrompt}></div>
	<div class="fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="w-full max-w-4xl rounded-lg border border-neutral-200 bg-white shadow-xl"
			role="dialog"
			aria-modal="true"
			on:click|stopPropagation
		>
			<div class="flex items-center justify-between border-b border-neutral-100 px-5 py-4">
				<div>
					<div class="text-base font-semibold text-neutral-900">Draft Tone</div>
					<div class="text-xs text-neutral-500">Review how the message changed before sending.</div>
				</div>
				<button
					type="button"
					class="text-sm text-neutral-400 hover:text-neutral-700"
					on:click={closeTonePrompt}
					disabled={tonePromptLoading}
				>
					Close
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
									class={segment.type === 'delete' ? 'rounded-sm bg-rose-100 text-rose-800' : ''}
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
					Send messages like this moving forward for similar issues?
				</div>
				{#if tonePromptError}
					<div class="mt-2 text-xs text-rose-600">{tonePromptError}</div>
				{/if}
			</div>
			<div class="flex items-center justify-end gap-2 border-t border-neutral-100 px-5 py-4">
				<button
					type="button"
					class="rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 transition hover:border-neutral-300"
					on:click={sendOnce}
					disabled={tonePromptLoading || isSending}
				>
					Just once
				</button>
				<button
					type="button"
					class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white transition hover:bg-neutral-800 disabled:opacity-60"
					on:click={approveAndSend}
					disabled={!hasToneDiff || tonePromptLoading || isSending}
				>
					{#if tonePromptLoading}
						Saving...
					{:else}
						Approve and send
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
