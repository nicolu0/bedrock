<script>
	// @ts-nocheck
	export let message;
	export let draft = null;

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
	let messageParts = { main: '', quoted: '' };
	let sentParts = { main: '', quoted: '' };

	$: if (draft && (draft.message_id ?? draft.id) !== lastMessageKey) {
		lastMessageKey = draft.message_id ?? draft.id;
		draftBody = draft.body ?? '';
		if (textareaEl) {
			textareaEl.style.height = 'auto';
			textareaEl.style.height = `${textareaEl.scrollHeight}px`;
		}
	}

	$: if (textareaEl && draft) {
		textareaEl.style.height = 'auto';
		textareaEl.style.height = `${textareaEl.scrollHeight}px`;
	}

	$: if (draft) {
		isExpanded = true;
	}

	const showToast = (message) => {
		toastMessage = message;
		if (toastTimeout) clearTimeout(toastTimeout);
		toastTimeout = setTimeout(() => {
			toastMessage = '';
		}, 2400);
	};

	const saveDraft = async () => {
		if (!draft?.message_id && !draft?.issue_id) return;
		if (draftBody === draft?.body) return;
		try {
			const response = await fetch('/api/email-drafts', {
				method: 'PATCH',
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
		if (!draft?.sender_email || !draft?.recipient_email) {
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
					draft.message_id ? { message_id: draft.message_id } : { issue_id: draft.issue_id }
				)
			});
			if (response.ok) {
				const payload = await response.json().catch(() => null);
				sentMessage = payload?.message ?? null;
				isSent = true;
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

	const formatSenderLabel = (sender) => {
		if (!sender) return 'Unknown';
		if (sender === 'tenant') return 'Tenant';
		if (sender === 'agent') return 'Bedrock Ops';
		if (sender === 'outbound') return 'You';
		return sender;
	};

	$: messageParts = splitEmailBody(message?.message ?? '');
	$: sentParts = splitEmailBody(sentMessage?.message ?? '');
</script>

{#if toastMessage}
	<div
		class="fixed right-4 bottom-4 z-50 rounded-md bg-neutral-900 px-3 py-2 text-xs text-white shadow-lg"
	>
		{toastMessage}
	</div>
{/if}

<div class="overflow-hidden rounded-md border border-neutral-100 bg-white">
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
					{formatSenderLabel(message?.sender)}
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
				<details class="mt-4">
					<summary
						class="inline-flex items-center justify-center gap-0.5 rounded-md px-1 py-2 transition hover:bg-neutral-100"
					>
						<span class="h-[3px] w-[3px] rounded-full bg-neutral-400"></span>
						<span class="h-[3px] w-[3px] rounded-full bg-neutral-400"></span>
						<span class="h-[3px] w-[3px] rounded-full bg-neutral-400"></span>
					</summary>
					<div class="mt-3 border-l-2 border-neutral-200 pl-4 text-neutral-600">
						<div class="break-words whitespace-pre-wrap">{messageParts.quoted}</div>
					</div>
				</details>
			{/if}
		</div>
	{/if}
	{#if draft && !isSent}
		<div class="border-t border-neutral-100 bg-white px-3 py-2">
			<div class="flex items-center gap-2 text-xs text-neutral-400">
				<span class="text-neutral-500">To</span>
				<span>{draft.recipient_email ?? ''}</span>
			</div>
			<div class="mt-3">
				<textarea
					class="w-full resize-none border-0 bg-transparent p-0 text-sm text-neutral-700 ring-0 outline-none focus:ring-0 focus:outline-none"
					rows="2"
					bind:value={draftBody}
					bind:this={textareaEl}
					on:input={queueSave}
				/>
			</div>
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
	{/if}
	{#if sentMessage}
		<div class="border-t border-neutral-100 bg-white">
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
							{formatSenderLabel(sentMessage?.sender ?? message?.sender)}
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
						<details class="mt-4">
							<summary
								class="inline-flex items-center justify-center gap-0.5 rounded-md px-1 py-2 transition hover:bg-neutral-100"
							>
								<span class="h-[3px] w-[3px] rounded-full bg-neutral-400"></span>
								<span class="h-[3px] w-[3px] rounded-full bg-neutral-400"></span>
								<span class="h-[3px] w-[3px] rounded-full bg-neutral-400"></span>
							</summary>
							<div class="mt-3 border-l-2 border-neutral-200 pl-4 text-neutral-600">
								<div class="break-words whitespace-pre-wrap">{sentParts.quoted}</div>
							</div>
						</details>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
