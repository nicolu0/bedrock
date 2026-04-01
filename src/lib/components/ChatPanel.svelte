<script>
	// @ts-nocheck
	import { createEventDispatcher, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import MessageThread from '$lib/components/MessageThread.svelte';
	import { chatMessages, addChatMessage, setChatMessages } from '$lib/stores/chatMessages.js';

	const dispatch = createEventDispatcher();

	let messageBody = '';
	let sending = false;
	let streaming = false;
	let streamingText = '';
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
		streaming = true;
		streamingText = '';
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
				headers: {
					'Content-Type': 'application/json',
					Accept: 'text/event-stream'
				},
				body: JSON.stringify({
					message: trimmed,
					workspace_id: $page.data?.workspace?.id,
					workspace_slug: $page.params.workspace,
					history,
					stream: true
				})
			});
			if (!response.ok || !response.body) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.error ?? 'Failed to chat');
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let replyText = '';
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					const lines = part.split('\n');
					let event = '';
					let data = '';
					for (const line of lines) {
						if (line.startsWith('event:')) event = line.replace('event:', '').trim();
						if (line.startsWith('data:')) data = line.replace('data:', '').trim();
					}
					if (!data) continue;
					if (event === 'delta') {
						const payload = JSON.parse(data);
						const delta = payload?.delta ?? '';
						if (delta) {
							replyText += delta;
							streamingText = replyText;
						}
					}
					if (event === 'error') {
						const payload = JSON.parse(data);
						throw new Error(payload?.error ?? 'Stream error');
					}
				}
			}
			streaming = false;
			streamingText = '';
			if (replyText) {
				addChatMessage({
					id: crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
					sender: 'agent',
					message: replyText,
					timestamp: new Date().toISOString()
				});
			}
		} catch (error) {
			streaming = false;
			streamingText = '';
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

	onMount(async () => {
		try {
			const response = await fetch('/api/chat');
			const data = await response.json().catch(() => ({}));
			if (response.ok) {
				const current = get(chatMessages);
				if (!current?.length) {
					setChatMessages(data?.messages ?? []);
				}
			}
		} catch {
			setChatMessages([]);
		}
	});
</script>

<div class="flex h-full flex-col">
	<div class="flex-1 overflow-y-auto px-5 py-4">
		<MessageThread
			messages={$chatMessages}
			{tenant}
			pending={streaming}
			pendingText={streamingText}
		/>
	</div>

	<div class="px-5 py-4">
		<div
			class="rounded-xl border border-neutral-100 bg-white px-3 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
		>
			<textarea
				class="w-full resize-none border-0 bg-transparent p-0 text-base text-neutral-700 outline-none placeholder:text-neutral-400 focus:shadow-none focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
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
