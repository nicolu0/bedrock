<script>
	// @ts-nocheck
	import { createEventDispatcher, onMount, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import MessageThread from '$lib/components/MessageThread.svelte';
	import ChatIssueRow from '$lib/components/ChatIssueRow.svelte';
	import ChatIssueRowLoading from '$lib/components/ChatIssueRowLoading.svelte';
	import ChatPropertyRow from '$lib/components/ChatPropertyRow.svelte';
	import { issuesCache } from '$lib/stores/issuesCache';
	import { propertiesCache } from '$lib/stores/propertiesCache';
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
	let showWelcomeOverlay = false;
	let overlayGreeting = '';
	let overlayIssues = [];
	let overlayDismissed = false;
	const OVERLAY_AWAY_MINUTES = 30;

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

	const getIssueReadableId = (issue) =>
		issue?.readableId ?? issue?.readable_id ?? issue?.issueNumber ?? issue?.issue_number ?? '';
	const slugify = (value) => {
		if (!value) return 'issue';
		const base = value
			.toString()
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
		return base || 'issue';
	};
	const getIssueHref = (issue) => {
		const readableId = getIssueReadableId(issue);
		if (!readableId) return null;
		const slug = slugify(issue?.title ?? issue?.name ?? 'issue');
		return `/${$page.params.workspace}/issue/${readableId}/${slug}`;
	};
	const getUserGreeting = () => {
		const name = $page.data?.user?.name ?? $page.data?.user?.full_name ?? 'there';
		const hours = new Date().getHours();
		const greeting = hours < 12 ? 'Good morning' : 'Welcome back';
		return `${greeting}, ${name}`;
	};
	const computeOverlayIssues = () => {
		const issues = $issuesCache?.data?.issues ?? [];
		return (issues ?? [])
			.filter((issue) => issue?.hasUnseenUpdates === true)
			.sort((a, b) => {
				const aTs = new Date(a?.updated_at ?? a?.updatedAt ?? 0).getTime();
				const bTs = new Date(b?.updated_at ?? b?.updatedAt ?? 0).getTime();
				return bTs - aTs;
			})
			.slice(0, 5);
	};
	const shouldShowOverlay = () => {
		if (!browser || overlayDismissed) return false;
		const lastOpenRaw = localStorage.getItem('chat:last_open_at');
		const lastOpen = lastOpenRaw ? Number(lastOpenRaw) : 0;
		const now = Date.now();
		const awayLongEnough = !lastOpen || now - lastOpen >= OVERLAY_AWAY_MINUTES * 60 * 1000;
		const issues = computeOverlayIssues();
		return awayLongEnough && issues.length > 0;
	};
	const openWelcomeOverlay = () => {
		if (!browser) return;
		overlayGreeting = getUserGreeting();
		overlayIssues = computeOverlayIssues();
		showWelcomeOverlay = overlayIssues.length > 0;
	};
	const dismissWelcomeOverlay = () => {
		if (!browser) return;
		showWelcomeOverlay = false;
		overlayDismissed = true;
		localStorage.setItem('chat:dismissed_at', String(Date.now()));
	};
	const toggleWelcomeOverlay = () => {
		if (showWelcomeOverlay) {
			dismissWelcomeOverlay();
			return;
		}
		overlayDismissed = false;
		openWelcomeOverlay();
	};

	const sendMessage = async () => {
		const trimmed = messageBody.trim();
		if (!trimmed || sending) return;
		if (showWelcomeOverlay) dismissWelcomeOverlay();
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
	const ISSUE_REF_REGEX = /\[\[issue_ref:([a-zA-Z0-9.-]+)\]\]/g;
	const PROPERTY_MARKER_REGEX = /\[\[property:(\{[\s\S]*?\})\]\]/g;
	const PROPERTY_REF_REGEX = /\[\[property_ref:([a-zA-Z0-9.-]+)\]\]/g;

	$: issueMap = new Map(($issuesCache?.data?.issues ?? []).map((item) => [item.id, item]));
	$: if ($issuesCache?.data?.issues?.length) {
		for (const item of $issuesCache.data.issues) {
			if (item.readableId) issueMap.set(item.readableId, item);
		}
	}
	$: propertyMap = new Map(($propertiesCache ?? []).map((item) => [item.id, item]));
	$: if (Array.isArray($propertiesCache)) {
		for (const item of $propertiesCache) {
			if (item?.name) propertyMap.set(item.name, item);
		}
	}

	const parseStreamingSegments = (text = '') => {
		const segments = [];
		let cursor = 0;
		const emitText = (value) => {
			if (!value) return;
			const cleaned = value.replace(/[\s,\.-]+$/g, '').replace(/^[\s,\.-]+/g, '');
			if (cleaned.trim()) segments.push({ type: 'text', value: cleaned });
		};
		while (cursor < text.length) {
			const markerStart = text.indexOf('[[', cursor);
			if (markerStart === -1) {
				emitText(text.slice(cursor));
				break;
			}
			if (markerStart > cursor) {
				emitText(text.slice(cursor, markerStart));
			}
			const markerEnd = text.indexOf(']]', markerStart + 2);
			if (markerEnd === -1) {
				segments.push({ type: 'issue-loading' });
				break;
			}
			const markerBody = text.slice(markerStart + 2, markerEnd);
			if (markerBody.startsWith('issue:')) {
				let issue = null;
				try {
					issue = JSON.parse(markerBody.slice(6));
				} catch {
					issue = null;
				}
				if (issue) segments.push({ type: 'issue', value: issue });
			} else if (markerBody.startsWith('issue_ref:')) {
				const ref = markerBody.slice(10);
				const issue = issueMap.get(ref);
				if (issue) segments.push({ type: 'issue', value: issue });
				else segments.push({ type: 'issue-loading' });
			} else if (markerBody.startsWith('property:')) {
				let property = null;
				try {
					property = JSON.parse(markerBody.slice(9));
				} catch {
					property = null;
				}
				if (property) segments.push({ type: 'property', value: property });
			} else if (markerBody.startsWith('property_ref:')) {
				const ref = markerBody.slice(13);
				const property = propertyMap.get(ref);
				if (property) segments.push({ type: 'property', value: property });
				else segments.push({ type: 'issue-loading' });
			}
			cursor = markerEnd + 2;
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
		if (browser) {
			localStorage.setItem('chat:last_open_at', String(Date.now()));
			if (shouldShowOverlay()) openWelcomeOverlay();
		}
		await focusInput();
		await tick();
		scrollToBottom();
	});

	$: if (messagesContainer && autoScroll) {
		scrollToBottom();
	}
	$: if (browser && !showWelcomeOverlay && !overlayDismissed && shouldShowOverlay()) {
		openWelcomeOverlay();
	}
</script>

<div class="relative flex h-full flex-col">
	<button
		type="button"
		class="absolute top-4 right-4 z-50 flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition hover:text-neutral-500"
		aria-label="Show updates"
		on:click={toggleWelcomeOverlay}
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			fill="currentColor"
			class="bi bi-bell-fill"
			viewBox="0 0 16 16"
		>
			<path
				d="M8 16a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2m.995-14.901a1 1 0 1 0-1.99 0A5 5 0 0 0 3 6c0 1.098-.5 6-2 7h14c-1.5-1-2-5.902-2-7 0-2.42-1.72-4.44-4.005-4.901"
			/>
		</svg>
	</button>
	<div
		class="flex-1 overflow-y-auto px-3 pt-6 pb-40"
		bind:this={messagesContainer}
		on:scroll={handleScroll}
		class:pointer-events-none={showWelcomeOverlay}
		class:overflow-hidden={showWelcomeOverlay}
	>
		<MessageThread messages={$chatMessages} {tenant} />
		{#if $chatStreaming.active}
			{#if $chatStreaming.text}
				<div class="w-full space-y-1 pt-2">
					{#each parseStreamingSegments($chatStreaming.text) as segment}
						{#if segment.type === 'text'}
							<div class="w-full max-w-[85%] rounded-2xl px-4 py-2 text-left">
								<div class="text-base leading-relaxed whitespace-pre-wrap text-neutral-800">
									{segment.value}
								</div>
							</div>
						{:else if segment.type === 'issue'}
							<div class="w-full">
								<ChatIssueRow issue={segment.value} />
							</div>
						{:else if segment.type === 'property'}
							<div class="w-full">
								<ChatPropertyRow property={segment.value} />
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

	<div class="relative z-50 px-3 pb-4">
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

	{#if showWelcomeOverlay}
		<div
			class="absolute inset-0 z-40 flex flex-col w-full px-4 justify-center bg-white/85 text-center backdrop-blur-sm"
			on:click={dismissWelcomeOverlay}
		>
			<div class="text-xl font-semibold text-neutral-900">{overlayGreeting}</div>
			<p class="mt-2 text-sm text-neutral-600">
				Here’s some changes that occurred while you were away
			</p>
			<div class="mt-4 space-y-1 text-left">
				{#each overlayIssues as issue}
					<div on:click|stopPropagation={() => dismissWelcomeOverlay()}>
						<ChatIssueRow {issue} />
					</div>
				{/each}
			</div>
			<div class="mt-4 text-xs text-neutral-400">Click anywhere or send a message to dismiss</div>
		</div>
	{/if}
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
