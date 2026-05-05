<script>
	// @ts-nocheck
	export let message;
	export let formatTimestamp;

	let expanded = false;

	const formatSenderLabel = (msg) => {
		if (msg?.direction === 'outbound') {
			return msg?.metadata?.sender_name || 'LAPM';
		}
		const sender = msg?.sender;
		if (sender === 'tenant') return msg?._participant_name || msg?.metadata?.sender_name || 'Tenant';
		if (sender === 'vendor') return msg?._participant_name || msg?.metadata?.sender_name || 'Vendor';
		if (sender === 'agent') return 'Bedrock';
		if (sender === 'manager') return msg?.metadata?.sender_name || 'LAPM';
		if (sender === 'unknown') return msg?.metadata?.sender_name || 'Unknown';
		return sender ?? 'Unknown';
	};

	const getSenderInitial = (msg) => {
		if (msg?.direction === 'outbound') {
			const outName = msg?.metadata?.sender_name;
			return outName ? outName.charAt(0).toUpperCase() : 'L';
		}
		const name = msg?._participant_name || msg?.metadata?.sender_name;
		const sender = msg?.sender;
		if (sender === 'tenant') return name ? name.charAt(0).toUpperCase() : 'T';
		if (sender === 'vendor') return name ? name.charAt(0).toUpperCase() : 'V';
		if (sender === 'agent') return 'B';
		if (sender === 'manager') return name ? name.charAt(0).toUpperCase() : 'L';
		return '?';
	};

	const getSenderColor = (msg) => {
		if (msg?.channel === 'imessage') return 'bg-green-100';
		if (msg?.direction === 'outbound') return 'bg-blue-100';
		const sender = msg?.sender;
		if (sender === 'tenant') return 'bg-amber-100';
		if (sender === 'vendor') return 'bg-purple-100';
		if (sender === 'agent') return 'bg-emerald-100';
		if (sender === 'manager') return 'bg-blue-100';
		return 'bg-neutral-100';
	};

	const getPreview = (msg) => {
		const body = msg?.message ?? '';
		if (body) {
			const firstLine = body.split('\n').find((l) => l.trim()) ?? '';
			return firstLine.length > 120 ? firstLine.slice(0, 120) + '...' : firstLine;
		}
		return msg?.subject || 'No content';
	};

	$: senderLabel = formatSenderLabel(message);
	$: initial = getSenderInitial(message);
	$: color = getSenderColor(message);
	$: preview = getPreview(message);
	$: isSms = message?.channel === 'sms' || message?.channel === 'appfolio_sms';
	$: isAppfolioEmail = message?.channel === 'appfolio_email';
	$: isImessage = message?.channel === 'imessage';
	$: isEmail = !isSms && !isImessage;
	$: directionIcon = message?.direction === 'outbound' ? '\u2192' : '\u2190';
	$: participantType = message?._participant_type ?? message?.metadata?.participant_type ?? null;
	$: roleTag = participantType === 'tenant' ? 'Tenant' : participantType === 'vendor' ? 'Vendor' : null;

	const getRecipientLabel = (msg) => {
		if (msg?.direction === 'outbound') {
			// Outbound: recipient is the tenant/vendor
			const ptype = msg?._participant_type ?? msg?.metadata?.participant_type;
			const pname = msg?._participant_name ?? msg?.metadata?.sender_name;
			if (ptype === 'tenant') return pname || 'Tenant';
			if (ptype === 'vendor') return pname || 'Vendor';
			return pname || 'Recipient';
		}
		// Inbound: recipient is the manager
		return 'LAPM';
	};
	$: recipientLabel = isAppfolioEmail ? getRecipientLabel(message) : null;
</script>

<button
	type="button"
	class="flex w-full cursor-pointer items-start gap-3 px-1 py-2 text-left transition hover:bg-neutral-50"
	on:click={() => (expanded = !expanded)}
>
	<div class="relative h-8 w-8 shrink-0">
		<div
			class={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-neutral-700 ${color}`}
		>
			{initial}
		</div>
		<div
			class="absolute -right-1 -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-600 shadow-sm"
		>
			{#if isEmail}
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 16 16"
					fill="currentColor"
					class="h-2 w-2"
				>
					<path
						d="M.05 3.555A2 2 0 0 1 2 2h12a2 2 0 0 1 1.95 1.555L8 8.414.05 3.555ZM0 4.697v7.104l5.803-3.558L0 4.697ZM6.761 8.83l-6.57 4.026A2 2 0 0 0 2 14h12a2 2 0 0 0 1.808-1.144l-6.57-4.027L8 9.586l-1.239-.757ZM16 11.801V4.697l-5.803 3.546L16 11.801Z"
					/>
				</svg>
			{:else}
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 16 16"
					fill="currentColor"
					class="h-2 w-2"
				>
					<path
						d="M3 2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V2zm6 11a1 1 0 1 0-2 0 1 1 0 0 0 2 0z"
					/>
				</svg>
			{/if}
		</div>
	</div>
	<div class="min-w-0 flex-1">
		<div class="flex min-w-0 items-start justify-between gap-4">
			<div class="min-w-0 flex-1">
				<span class="text-sm font-medium text-neutral-900">{senderLabel}</span>
				{#if roleTag && message?.direction !== 'outbound'}
					<span class="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">{roleTag}</span>
				{/if}
				<span class="mx-1 text-xs text-neutral-400">{directionIcon}</span>
				{#if recipientLabel}
					<span class="text-sm text-neutral-900">{recipientLabel}</span>
				{/if}
				{#if !recipientLabel && message?.subject}
					<span class="text-xs text-neutral-500">{message.subject}</span>
				{/if}
				{#if isAppfolioEmail && message?.subject}
					<p class="truncate text-xs text-neutral-500">{message.subject}</p>
				{/if}
				{#if !expanded}
					<p class="truncate text-sm text-neutral-600">{preview}</p>
				{/if}
			</div>
			<span class="shrink-0 text-xs text-neutral-400">
				{formatTimestamp(message?.timestamp)}
			</span>
		</div>
		{#if expanded}
			<div class="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700">
				{message?.message || message?.subject || 'No content'}
			</div>
		{/if}
	</div>
</button>
