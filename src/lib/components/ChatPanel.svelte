<script>
	// @ts-nocheck
	import { createEventDispatcher, onMount, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import MessageThread from '$lib/components/MessageThread.svelte';
	import ChatIssueRow from '$lib/components/ChatIssueRow.svelte';
	import ChatIssueRowLoading from '$lib/components/ChatIssueRowLoading.svelte';
	import { issuesCache } from '$lib/stores/issuesCache';
	import {
		chatMessages,
		chatStreaming,
		addChatMessage,
		setChatMessages,
		startChatStreaming,
		updateChatStreamingText,
		stopChatStreaming
	} from '$lib/stores/chatMessages.js';

	const dispatch = createEventDispatcher();

	let messageBody = '';
	let sending = false;
	let chatTextarea;
	let messagesContainer;
	let isAtBottom = true;
	let autoScroll = true;
	let finalTextFromServer = null;
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
		startChatStreaming();
		const userMessage = {
			id: crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
			sender: 'tenant',
			message: trimmed,
			timestamp: new Date().toISOString()
		};
		const history = buildHistory($chatMessages);
		addChatMessage(userMessage);
		autoScroll = true;
		messageBody = '';
		resizeChatTextarea();
		await tick();
		scrollToBottom();
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
			finalTextFromServer = null;
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
							updateChatStreamingText(replyText);
						}
					}
					if (event === 'final') {
						const payload = JSON.parse(data);
						finalTextFromServer = payload?.text ?? null;
					}
					if (event === 'error') {
						const payload = JSON.parse(data);
						throw new Error(payload?.error ?? 'Stream error');
					}
				}
			}
			stopChatStreaming();
			const finalMessage = finalTextFromServer ?? replyText;
			if (finalMessage) {
				addChatMessage({
					id: crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
					sender: 'agent',
					message: finalMessage,
					timestamp: new Date().toISOString()
				});
				autoScroll = true;
				await tick();
				scrollToBottom();
			}
		} catch (error) {
			stopChatStreaming();
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
		if (event.key === 'Escape') {
			event.preventDefault();
			chatTextarea?.blur();
			return;
		}
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		sendMessage();
	};

	const focusInput = async () => {
		await tick();
		chatTextarea?.focus();
	};

	const scrollToBottom = () => {
		if (!messagesContainer) return;
		messagesContainer.scrollTop = messagesContainer.scrollHeight;
	};

	const ISSUE_MARKER_REGEX = /\[\[issue:(\{[\s\S]*?\})\]\]/g;
	const ISSUE_REF_REGEX = /\[\[issue_ref:([a-zA-Z0-9-]+)\]\]/g;

	$: issueMap = new Map(($issuesCache?.data?.issues ?? []).map((item) => [item.id, item]));
	$: if ($issuesCache?.data?.issues?.length) {
		for (const item of $issuesCache.data.issues) {
			if (item.readableId) issueMap.set(item.readableId, item);
		}
	}

	const parseStreamingSegments = (text = '') => {
		const segments = [];
		let lastIndex = 0;
		const combinedRegex = new RegExp(`${ISSUE_MARKER_REGEX.source}|${ISSUE_REF_REGEX.source}`, 'g');
		const matches = text.matchAll(combinedRegex);
		for (const match of matches) {
			const start = match.index ?? 0;
			const end = start + match[0].length;
			const before = text.slice(lastIndex, start);
			if (before.trim() && !/^[\s,\.-]+$/.test(before)) {
				segments.push({ type: 'text', value: before });
			}
			if (match[1]) {
				let issue = null;
				try {
					issue = JSON.parse(match[1]);
				} catch {
					issue = null;
				}
				if (issue) segments.push({ type: 'issue', value: issue });
			} else if (match[2]) {
				const ref = match[2];
				const issue = issueMap.get(ref);
				if (issue) segments.push({ type: 'issue', value: issue });
				else segments.push({ type: 'issue-loading' });
			}
			lastIndex = end;
		}
		const rest = text.slice(lastIndex);
		if (rest.trim() && !/^[\s,\.-]+$/.test(rest)) segments.push({ type: 'text', value: rest });
		if (rest.includes('[[issue_ref:') || rest.endsWith('[[') || rest.endsWith('[[issue_ref')) {
			segments.push({ type: 'issue-loading' });
		}
		return segments;
	};

	const handleScroll = () => {
		if (!messagesContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
		const atBottom = scrollTop + clientHeight >= scrollHeight - 8;
		isAtBottom = atBottom;
		autoScroll = atBottom;
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
		await focusInput();
		await tick();
		scrollToBottom();
	});

	$: if (messagesContainer && autoScroll) {
		scrollToBottom();
	}
</script>

<div class="flex h-full flex-col">
	<div
		class="flex-1 overflow-y-auto px-3 pt-6 pb-40"
		bind:this={messagesContainer}
		on:scroll={handleScroll}
	>
		<MessageThread messages={$chatMessages} {tenant} />
		{#if $chatStreaming.active}
			{#if $chatStreaming.text}
				<div class="w-full space-y-3 pt-6">
					{#each parseStreamingSegments($chatStreaming.text) as segment}
						{#if segment.type === 'text'}
							<div class="w-full max-w-[85%] rounded-2xl px-4 py-4 text-left">
								<div class="text-base leading-relaxed whitespace-pre-wrap text-neutral-800">
									{segment.value}
								</div>
							</div>
						{:else if segment.type === 'issue'}
							<div class="w-full">
								<ChatIssueRow issue={segment.value} />
							</div>
						{:else if segment.type === 'issue-loading'}
							<ChatIssueRowLoading />
						{/if}
					{/each}
				</div>
			{:else}
				<div class="w-full px-4 pt-6">
					<span class="thinking-sheen" data-text="Thinking">Thinking</span>
				</div>
			{/if}
		{/if}
	</div>

	<div class="relative px-3 pb-4">
		{#if !isAtBottom}
			<button
				type="button"
				class="absolute -top-10 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-500 shadow-sm"
				aria-label="Scroll to bottom"
				on:click={() => {
					autoScroll = true;
					scrollToBottom();
				}}
				in:fly={{ y: 6, duration: 160 }}
				out:fly={{ y: 6, duration: 120 }}
			>
				<span>Scroll to bottom</span>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="12"
					height="12"
					fill="currentColor"
					class="bi bi-arrow-down"
					viewBox="0 0 16 16"
				>
					<path
						fill-rule="evenodd"
						d="M8 1a.5.5 0 0 1 .5.5v11.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L7.5 13.293V1.5A.5.5 0 0 1 8 1"
					/>
				</svg>
			</button>
		{/if}
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

<style>
	.thinking-sheen {
		position: relative;
		display: inline-block;
		color: #9ca3af;
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
			rgba(255, 255, 255, 0.2) 0%,
			rgba(255, 255, 255, 0.95) 45%,
			rgba(255, 255, 255, 0.2) 90%
		);
		background-size: 200% 100%;
		background-position: 200% 50%;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: thinking-sheen 1.2s ease-in-out infinite;
	}

	@keyframes thinking-sheen {
		0% {
			background-position: 200% 50%;
		}
		100% {
			background-position: 0% 50%;
		}
	}
</style>
