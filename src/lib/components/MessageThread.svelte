<script>
	// @ts-nocheck

	export let messages = [];
	export let tenant = { name: 'Tenant', email: '' };

	const formatTime = (iso) => {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	};

	const senderLabel = (sender) => {
		if (sender === 'tenant') return tenant?.name ?? 'Tenant';
		if (sender === 'vendor') return 'Vendor';
		return 'Bedrock Ops';
	};

	const displayFromName = (m) => {
		if (m?.sender === 'vendor') return m?.fromName ?? 'Vendor';
		return senderLabel(m?.sender);
	};
</script>

<div class="space-y-3">
	{#if !messages?.length}
		<div class="mt-3 text-sm text-neutral-500">No messages yet.</div>
	{:else}
		<div class="space-y-4">
			{#each messages as m (m.id)}
				{@const isAgent = m?.sender === 'agent'}
				<div class={`w-full ${isAgent ? '' : 'flex justify-end'}`}>
					<div
						class={`w-full max-w-[85%] rounded-2xl px-5 py-4 text-left ${
							isAgent ? 'bg-transparent' : 'bg-neutral-100'
						}`}
					>
						<div class="flex items-start justify-between gap-6">
							<div class="min-w-0">
								<div class="truncate text-sm font-medium text-neutral-900">
									{displayFromName(m)}
								</div>
								<div class="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-neutral-800">
									{m.message}
								</div>
							</div>
							<div class="flex items-center gap-3 text-xs text-neutral-400">
								<span>{formatTime(m.timestamp)}</span>
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
