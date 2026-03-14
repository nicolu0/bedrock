<script>
	// @ts-nocheck
	import { onDestroy, createEventDispatcher } from 'svelte';
	import { fade } from 'svelte/transition';
	import { removeDraftFromCache, applyMessageDelta } from '$lib/stores/activityCache.js';
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
	let toastTimeout;
	let isExpanded = Boolean(draft);
	let isQuotedExpanded = false;
	let isSentQuotedExpanded = false;
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
		localRecipientEmails = normalizeRecipientList(
			draft?.recipient_emails ?? draft?.recipient_email
		);
		recipients = localRecipientEmails.map((email) => ({ email }));
		if (textareaEl) {
			textareaEl.style.height = 'auto';
			textareaEl.style.height = `${textareaEl.scrollHeight}px`;
		}
	}

	$: if (textareaEl) {
		textareaEl.style.height = 'auto';
		textareaEl.style.height = `${textareaEl.scrollHeight}px`;
	}

	$: if (draft) {
		isExpanded = true;
	}

	$: if (!isExpanded) {
		isQuotedExpanded = false;
		isSentQuotedExpanded = false;
	}

	const showToast = (message) => {
		toastMessage = message;
		if (toastTimeout) clearTimeout(toastTimeout);
		toastTimeout = setTimeout(() => {
			toastMessage = '';
		}, 3000);
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

	const sendDraft = async () => {
		if (!draft?.message_id && !draft?.issue_id) return;
		const effectiveRecipients = recipients.map((r) => r.email).filter(Boolean);
		if (!draft?.sender_email || !effectiveRecipients.length) {
			showToast('Draft needs sender and recipient email.');
			return;
		}
		if (isSending || isSent) return;
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
			if (response.ok) {
				const payload = await response.json().catch(() => null);
				sentMessage = payload?.message ?? null;
				isSent = true;
				removeDraftFromCache(draft);
				if (sentMessage) applyMessageDelta(sentMessage);
				dispatch('sent', { issueId: draft.issue_id ?? null });
			}
		} catch {
			// ignore send failures
		} finally {
			isSending = false;
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

	$: messageParts = splitEmailBody(message?.message ?? '');
	$: sentParts = splitEmailBody(sentMessage?.message ?? '');
</script>

<svelte:window on:click={handleWindowClick} />

{#if toastMessage}
	<div
		transition:fade={{ duration: 100 }}
		class="fixed right-4 bottom-4 z-50 rounded-md bg-neutral-900 px-3 py-2 text-xs text-white shadow-[0_2px_12px_rgba(0,0,0,0.18)]"
	>
		{toastMessage}
	</div>
{/if}

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
				<div class="mt-3 flex items-center justify-end">
					<button
						class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 disabled:opacity-50"
						type="button"
						on:click={sendDraft}
						disabled={isSending}
					>
						{#if isSending}
							<span class="text-[10px] font-semibold">...</span>
						{:else}
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
