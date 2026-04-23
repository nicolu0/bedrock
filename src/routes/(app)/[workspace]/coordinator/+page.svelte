<script>
	// @ts-nocheck
	import { onDestroy, onMount, tick } from 'svelte';
	import { page } from '$app/stores';
	import { invalidate } from '$app/navigation';
	import { supabase } from '$lib/supabaseClient.js';

	export let data;

	$: coordinator = data?.coordinator ?? {
		threadId: null,
		label: 'Coordinator',
		messages: [],
		issuesById: {},
		openIssues: []
	};
	$: workspaceSlug = $page.params.workspace;
	$: workspaceId = data?.workspace?.id ?? null;
	$: threadId = coordinator.threadId;
	$: messages = coordinator.messages ?? [];
	$: issuesById = coordinator.issuesById ?? {};
	$: openIssues = coordinator.openIssues ?? [];
	$: label = coordinator.label ?? 'Coordinator';

	let pickerOpenFor = null;
	let pickerQuery = '';
	let scrollContainer;
	let rtChannel = null;

	$: filteredOpenIssues = pickerQuery
		? openIssues.filter((i) =>
				`${i.readable_id ?? ''} ${i.service_request_number ?? ''} ${i.name ?? ''}`
					.toLowerCase()
					.includes(pickerQuery.toLowerCase())
			)
		: openIssues.slice(0, 40);

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

	async function linkTo(messageId, issueId) {
		const res = await fetch('/api/imessage/link', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message_id: messageId, issue_id: issueId })
		});
		if (!res.ok) {
			const text = await res.text();
			alert(`Link failed: ${text}`);
			return;
		}
		pickerOpenFor = null;
		pickerQuery = '';
		await invalidate('app:coordinator');
	}

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
			href={`/${workspaceSlug}/settings`}
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
			{@const linkedIssue = msg.issue_id ? issuesById[msg.issue_id] : null}
			<div class={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}>
				<div class="max-w-[min(70%,42rem)]">
					<div class={`text-[11px] ${isOutbound ? 'text-right' : 'text-left'} text-neutral-500`}>
						{senderLabel(msg)} · {formatTime(msg.timestamp)}
					</div>
					<div
						class={`mt-1 rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
							isOutbound
								? 'bg-blue-500 text-white'
								: 'bg-neutral-100 text-neutral-900'
						}`}
					>
						{msg.message}
					</div>
					<div class={`mt-1 flex items-center gap-2 text-[11px] ${isOutbound ? 'justify-end' : 'justify-start'}`}>
						{#if linkedIssue}
							<a
								href={`/${workspaceSlug}/issue/${linkedIssue.readable_id ?? linkedIssue.id}/${encodeURIComponent((linkedIssue.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`}
								class="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-emerald-800 hover:bg-emerald-100"
								title={msg.metadata?.link?.reason ?? ''}
							>
								→ {linkedIssue.service_request_number ? `#${linkedIssue.service_request_number} ` : ''}{linkedIssue.name}
							</a>
							<button
								type="button"
								on:click={() => linkTo(msg.id, null)}
								class="text-neutral-400 hover:text-neutral-700"
							>
								unlink
							</button>
						{:else}
							<button
								type="button"
								on:click={() => {
									pickerOpenFor = msg.id;
									pickerQuery = '';
								}}
								class="rounded border border-neutral-200 px-2 py-0.5 text-neutral-500 hover:bg-neutral-50"
							>
								Link to issue…
							</button>
						{/if}
					</div>

					{#if pickerOpenFor === msg.id}
						<div class={`mt-2 rounded-md border border-neutral-200 bg-white p-2 shadow-sm ${isOutbound ? 'ml-auto' : ''}`}>
							<input
								type="text"
								placeholder="Search issues by name, #, or ID…"
								bind:value={pickerQuery}
								class="mb-2 w-full rounded border border-neutral-200 px-2 py-1 text-sm focus:border-neutral-400 focus:outline-none"
							/>
							<div class="max-h-60 overflow-y-auto">
								{#each filteredOpenIssues as issue (issue.id)}
									<button
										type="button"
										on:click={() => linkTo(msg.id, issue.id)}
										class="flex w-full flex-col items-start rounded px-2 py-1 text-left text-sm hover:bg-neutral-100"
									>
										<span class="text-neutral-900">
											{issue.service_request_number ? `#${issue.service_request_number} ` : ''}{issue.name}
										</span>
										{#if issue.readable_id}
											<span class="text-[11px] text-neutral-400">{issue.readable_id}</span>
										{/if}
									</button>
								{/each}
								{#if !filteredOpenIssues.length}
									<div class="px-2 py-2 text-xs text-neutral-500">No matching open issues.</div>
								{/if}
							</div>
							<div class="mt-1 flex justify-end">
								<button
									type="button"
									on:click={() => (pickerOpenFor = null)}
									class="text-[11px] text-neutral-400 hover:text-neutral-700"
								>
									Cancel
								</button>
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>
