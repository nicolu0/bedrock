<script>
	// @ts-nocheck
	import { onDestroy, onMount, tick } from 'svelte';
	import { page } from '$app/stores';
	import { invalidate } from '$app/navigation';
	import { supabase } from '$lib/supabaseClient.js';

	export let data;

	const DEFAULT_COORD = {
		threadId: null,
		label: 'Coordinator',
		chatGuid: null,
		messages: []
	};

	$: coordinator = data?.coordinator ?? DEFAULT_COORD;
	$: workspaceSlug = $page.params.workspace;
	$: threadId = coordinator.threadId;
	$: messages = coordinator.messages ?? [];
	$: label = coordinator.label ?? 'Coordinator';

	let scrollContainer;
	let rtChannel = null;

	function formatTime(ts) {
		if (!ts) return '';
		const date = new Date(ts);
		const now = new Date();
		const sameDay =
			date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate();
		if (sameDay) {
			return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		}
		return date.toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function senderLabel(msg) {
		return msg?.metadata?.sender_name ?? (msg?.direction === 'outbound' ? 'Bedrock' : label);
	}

	async function scrollToBottom() {
		await tick();
		if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
	}

	$: if (messages.length) scrollToBottom();

	onMount(() => {
		if (!threadId) return;
		rtChannel = supabase
			.channel(`coordinator-${threadId}`)
			.on(
				'postgres_changes',
				{
					event: '*',
					schema: 'public',
					table: 'messages',
					filter: `thread_id=eq.${threadId}`
				},
				() => {
					invalidate('app:coordinator');
				}
			)
			.subscribe();
	});

	onDestroy(() => {
		if (rtChannel) {
			supabase.removeChannel(rtChannel);
			rtChannel = null;
		}
	});
</script>

<div class="flex h-full min-h-0 flex-col bg-white">
	<div class="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
		<div class="flex items-center gap-3">
			<h1 class="text-sm font-medium text-neutral-900">Coordinator · {label}</h1>
			{#if !coordinator.chatGuid}
				<span class="rounded bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
					Not configured — see Settings
				</span>
			{/if}
		</div>
		<a
			href={`/${workspaceSlug}/settings/coordinator`}
			class="text-[12px] text-neutral-500 hover:text-neutral-800"
		>
			Settings
		</a>
	</div>

	<div bind:this={scrollContainer} class="flex-1 space-y-3 overflow-y-auto px-5 py-4">
		{#if !threadId}
			<div class="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500">
				No iMessages yet. Install the sync script on your Mac and messages from the configured
				group chat will appear here.
			</div>
		{:else if !messages.length}
			<div class="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500">
				Thread is set up but no messages have synced yet.
			</div>
		{/if}

		{#each messages as msg (msg.id)}
			{@const isOutbound = msg.direction === 'outbound'}
			<div class={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}>
				<div class="max-w-[min(70%,42rem)]">
					<div class={`text-[11px] ${isOutbound ? 'text-right' : 'text-left'} text-neutral-500`}>
						{senderLabel(msg)} · {formatTime(msg.timestamp)}
					</div>
					<div
						class={`mt-1 rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
							isOutbound ? 'bg-blue-500 text-white' : 'bg-neutral-100 text-neutral-900'
						}`}
					>
						{msg.message}
					</div>
				</div>
			</div>
		{/each}
	</div>
</div>
