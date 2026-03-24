<script>
	// @ts-nocheck
	import { fly } from 'svelte/transition';
	import { agentToasts } from '$lib/stores/agentToasts';
</script>

{#if $agentToasts.length}
	<div
		class="pointer-events-none fixed right-4 bottom-4 flex w-full max-w-xs flex-col gap-2"
		style="z-index: 2147483647;"
		aria-live="polite"
	>
		{#each $agentToasts as toast (toast.runId)}
			<div
				in:fly={{ y: 12, duration: 160 }}
				out:fly={{ y: 12, duration: 160 }}
				class="pointer-events-auto flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-lg"
			>
				<div class="flex h-6 w-6 items-center justify-center">
					{#if toast.stage === 'done'}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="16"
							height="16"
							fill="currentColor"
							class="text-emerald-600"
							viewBox="0 0 16 16"
						>
							<path
								d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"
							/>
						</svg>
					{:else}
						<span
							class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800"
						></span>
					{/if}
				</div>
				<div class="min-w-0 flex-1">
					<div class="truncate text-xs font-medium text-neutral-800">{toast.title}</div>
				</div>
			</div>
		{/each}
	</div>
{/if}
