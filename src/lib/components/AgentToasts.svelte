<script>
	// @ts-nocheck
	import { agentToasts } from '$lib/stores/agentToasts';
</script>

{#if $agentToasts.length}
	<div
		class="pointer-events-none fixed right-4 bottom-4 z-[99999] flex w-full max-w-xs flex-col gap-2"
	>
		{#each $agentToasts as toast (toast.runId)}
			<div
				class="pointer-events-auto flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-lg"
			>
				<div class="flex h-6 w-6 items-center justify-center">
					<span
						class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800"
					></span>
				</div>
				<div class="min-w-0 flex-1">
					<div class="truncate text-xs font-medium text-neutral-800">{toast.title}</div>
				</div>
			</div>
		{/each}
	</div>
{/if}
