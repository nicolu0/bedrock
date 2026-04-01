<script>
	// @ts-nocheck

	export let messages = [];
	export let tenant = { name: 'Tenant', email: '' };

	const senderLabel = (sender) => {
		if (sender === 'vendor') return 'Vendor';
		return 'Bedrock Ops';
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
						class={`w-full max-w-[85%] rounded-2xl px-4 py-4 text-left ${
							isAgent ? 'bg-transparent' : 'bg-neutral-100'
						}`}
					>
						<div class="text-base leading-relaxed whitespace-pre-wrap text-neutral-800">
							{m.message}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
