<script>
	// @ts-nocheck
	export let message;
	export let draft = null;

	let draftBody = draft?.body ?? '';
	let saveTimeout;
	let lastMessageId = draft?.message_id ?? null;
	let textareaEl;
	let isSending = false;
	let isSent = false;
	let sentMessage = null;

	$: if (draft?.message_id && draft.message_id !== lastMessageId) {
		lastMessageId = draft.message_id;
		draftBody = draft.body ?? '';
		if (textareaEl) {
			textareaEl.style.height = 'auto';
			textareaEl.style.height = `${textareaEl.scrollHeight}px`;
		}
	}

	$: if (textareaEl && draft?.message_id) {
		textareaEl.style.height = 'auto';
		textareaEl.style.height = `${textareaEl.scrollHeight}px`;
	}

	const saveDraft = async () => {
		if (!draft?.message_id) return;
		if (draftBody === draft?.body) return;
		try {
			const response = await fetch('/api/email-drafts', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message_id: draft.message_id, body: draftBody })
			});
			if (response.ok) {
				draft.body = draftBody;
			}
		} catch {
			// ignore save failures
		}
	};

	const sendDraft = async () => {
		if (!draft?.message_id) return;
		if (isSending || isSent) return;
		try {
			isSending = true;
			const response = await fetch('/api/email-drafts/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message_id: draft.message_id })
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
</script>

<div class="overflow-hidden rounded-md border border-neutral-100 bg-white">
	<div class="px-3 py-2">
		<div class="flex items-center justify-between text-xs text-neutral-400">
			<span>
				{message.direction === 'outbound' ? 'Outbound' : 'Inbound'}
				{#if message.subject}
					· {message.subject}
				{/if}
			</span>
			<span>{message.timestampLabel}</span>
		</div>
		<div class="mt-1 text-neutral-700">{message.message}</div>
	</div>
	{#if draft && !isSent}
		<div class="border-t border-neutral-100 bg-white px-3 py-2">
			<div class="flex items-center gap-2 text-xs text-neutral-400">
				<span class="text-neutral-500">To</span>
				<span>{draft.recipient}</span>
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
		<div class="border-t border-neutral-100 bg-white px-3 py-2">
			<div class="flex items-center justify-between text-xs text-neutral-400">
				<span>
					{sentMessage.direction === 'outbound' ? 'Outbound' : 'Inbound'}
					{#if sentMessage.subject}
						· {sentMessage.subject}
					{/if}
				</span>
				<span>{message.timestampLabel}</span>
			</div>
			<div class="mt-1 text-neutral-700">{sentMessage.message}</div>
		</div>
	{/if}
</div>
