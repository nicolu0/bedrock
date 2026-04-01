<script>
	// @ts-nocheck
	import { createEventDispatcher } from 'svelte';
	import { page } from '$app/stores';
	import MessageThread from '$lib/components/MessageThread.svelte';
	import { chatMessages, addChatMessage } from '$lib/stores/chatMessages.js';

	const dispatch = createEventDispatcher();

	let messageBody = '';
	let sending = false;
	let chatTextarea;
	const tenant = { name: 'You', email: '' };

	const resizeChatTextarea = () => {
		if (!chatTextarea) return;
		chatTextarea.style.height = 'auto';
		chatTextarea.style.height = `${chatTextarea.scrollHeight}px`;
	};

	const buildHistory = (messages) =>
		(messages ?? []).slice(-8).map((msg) => ({
			role: msg.sender === 'agent' ? 'assistant' : 'user',
			content: msg.message
		}));

	const sendMessage = async () => {
		const trimmed = messageBody.trim();
		if (!trimmed || sending) return;
		sending = true;
		const userMessage = {
			id: crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
			sender: 'tenant',
			message: trimmed,
			timestamp: new Date().toISOString()
		};
		const history = buildHistory($chatMessages);
		addChatMessage(userMessage);
		messageBody = '';
		resizeChatTextarea();
		try {
			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: trimmed,
					workspace_id: $page.data?.workspace?.id,
					workspace_slug: $page.params.workspace,
					history
				})
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data?.error ?? 'Failed to chat');
			addChatMessage({
				id: crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
				sender: 'agent',
				message: data?.reply ?? 'No response yet.',
				timestamp: new Date().toISOString()
			});
		} catch (error) {
			addChatMessage({
				id: crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
				sender: 'agent',
				message: 'Sorry, I could not reach chat right now.',
				timestamp: new Date().toISOString()
			});
		} finally {
			sending = false;
		}
	};

	const handleKeydown = (event) => {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		sendMessage();
	};
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
		<div class="flex items-center gap-2 text-neutral-700"></div>
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
		<MessageThread messages={$chatMessages} {tenant} />
	</div>

	<div class="border-t border-neutral-200 px-6 py-4">
		<div
			class="rounded-xl border border-neutral-100 bg-white px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
		>
			<textarea
				class="w-full resize-none border-0 bg-transparent p-0 text-sm text-neutral-700 outline-none placeholder:text-neutral-400 focus:shadow-none focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
				placeholder="Ask Bedrock"
				rows="1"
				bind:value={messageBody}
				bind:this={chatTextarea}
				on:input={resizeChatTextarea}
				on:keydown={handleKeydown}
			></textarea>
			<div class="mt-1 flex items-center justify-end">
				<button
					type="button"
					class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 focus-visible:outline-none disabled:opacity-50"
					aria-label="Send"
					disabled={!messageBody.trim() || sending}
					on:click={sendMessage}
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
