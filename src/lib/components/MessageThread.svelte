<script>
	// @ts-nocheck

	export let messages = [];
	export let tenant = { name: 'Tenant', email: '' };
	export let pending = false;
	export let pendingText = '';
</script>

<div class="space-y-3">
	{#if !messages?.length}
		<div class="mt-3 text-sm text-neutral-500">No messages yet.</div>
	{:else}
		<div class="space-y-4">
			{#each messages as m (m.id)}
				{@const isAgent = m?.sender === 'agent'}
				{@const bubbleText = m?.message ?? ''}
				<div class={`w-full ${isAgent ? '' : 'flex justify-end'}`}>
					<div
						class={`w-full max-w-[85%] rounded-2xl px-4 py-4 text-left ${
							isAgent ? 'bg-transparent' : 'bg-neutral-100'
						}`}
					>
						<div class="text-base leading-relaxed whitespace-pre-wrap text-neutral-800">
							{bubbleText}
						</div>
					</div>
				</div>
			{/each}
			{#if pending}
				<div class="w-full">
					<div class="w-full max-w-[85%] rounded-2xl px-4 py-4 text-left">
						<div class="text-base leading-relaxed whitespace-pre-wrap text-neutral-800">
							<span class="thinking-sheen" data-text={pendingText || 'Thinking'}>
								{pendingText || 'Thinking'}
							</span>
						</div>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.thinking-sheen {
		position: relative;
		display: inline-block;
		color: #6b7280;
	}

	.thinking-sheen::after {
		content: attr(data-text);
		position: absolute;
		left: 0;
		top: 0;
		width: 100%;
		color: transparent;
		background-image: linear-gradient(
			90deg,
			rgba(120, 120, 120, 0.2) 0%,
			rgba(80, 80, 80, 0.95) 45%,
			rgba(120, 120, 120, 0.2) 90%
		);
		background-size: 200% 100%;
		background-position: 0% 50%;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: thinking-sheen 1.2s ease-in-out infinite;
	}

	@keyframes thinking-sheen {
		0% {
			background-position: 0% 50%;
		}
		100% {
			background-position: 200% 50%;
		}
	}
</style>
