<script>
	// @ts-nocheck
	import { createEventDispatcher } from 'svelte';
	import MessageThread from '$lib/components/MessageThread.svelte';

	export let messages = [];
	export let tenant = { name: 'Resident', email: '' };

	const dispatch = createEventDispatcher();
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
		<div class="flex items-center gap-2 text-neutral-700">
			<span class="text-sm font-medium">Chat</span>
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
		<MessageThread {messages} {tenant} />
	</div>

	<div class="px-6 py-4">
		<div
			class="rounded-md border border-neutral-100 bg-white px-4 py-3 shadow-[0_2px_6px_rgba(0,0,0,0.08)]"
		>
			<textarea
				class="w-full resize-none border-0 bg-transparent p-0 text-sm text-neutral-700 outline-none placeholder:text-neutral-400 focus:shadow-none focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
				disabled
				placeholder="Ask Bedrock"
				rows="1"
			></textarea>
			<div class="mt-1 flex items-center justify-end">
				<button
					type="button"
					class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 focus-visible:outline-none disabled:opacity-50"
					aria-label="Send"
					disabled
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="18"
						height="18"
						viewBox="0 0 16 16"
						fill="currentColor"
					>
						<path
							d="M8 12a.5.5 0 0 0 .5-.5V4.707l2.147 2.147a.5.5 0 0 0 .707-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 4.707V11.5A.5.5 0 0 0 8 12z"
						/>
					</svg>
				</button>
			</div>
		</div>
	</div>
</div>
