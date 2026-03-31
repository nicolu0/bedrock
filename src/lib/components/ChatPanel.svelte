<script>
	// @ts-nocheck
	import { createEventDispatcher } from 'svelte';
	import MessageThread from '$lib/components/MessageThread.svelte';

	export let messages = [];
	export let tenant = { name: 'Resident', email: '' };

	const dispatch = createEventDispatcher();
</script>

<div class="flex h-full flex-col">
	<div
		class="flex items-center justify-between border-b border-neutral-200 px-6 py-3 text-sm text-neutral-600"
	>
		<div class="flex items-center gap-2 text-neutral-700">
			<span class="text-sm font-medium">Chat</span>
			<span class="text-xs text-neutral-400">Bedrock assistant</span>
		</div>
		<button
			on:click={() => dispatch('close')}
			class="ml-3 shrink-0 text-neutral-400 transition hover:text-neutral-600"
			aria-label="Close panel"
			type="button"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="16"
				height="16"
				fill="currentColor"
				viewBox="0 0 16 16"
			>
				<path
					d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"
				/>
			</svg>
		</button>
	</div>

	<div class="flex-1 overflow-y-auto px-6 py-4">
		<div
			class="rounded-xl border border-neutral-200/70 bg-neutral-50 px-4 py-3 text-sm text-neutral-600"
		>
			Ask Bedrock to triage issues, draft messages, or pull recent context.
		</div>
		<div class="mt-4">
			<MessageThread {messages} {tenant} />
		</div>
	</div>

	<div class="border-t border-neutral-200 px-6 py-4">
		<div class="flex items-center gap-2">
			<input
				class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 placeholder:text-neutral-400"
				disabled
				placeholder="Chat coming soon"
				type="text"
			/>
			<button
				class="rounded-lg bg-neutral-200 px-3 py-2 text-xs text-neutral-500"
				disabled
				type="button"
			>
				Send
			</button>
		</div>
	</div>
</div>
