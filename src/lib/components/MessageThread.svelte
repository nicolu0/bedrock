<script>
	// @ts-nocheck
	import { onMount } from 'svelte';

	export let messages = [];
	export let tenant = { name: 'Tenant', email: '' };

	let expandedIds = [];

	const formatTime = (iso) => {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	};

	const senderLabel = (sender) => {
		if (sender === 'tenant') return tenant?.name ?? 'Tenant';
		if (sender === 'vendor') return 'Vendor';
		return 'Bedrock Ops';
	};

	const senderMeta = (m) => {
		if (m?.sender === 'tenant') return 'To me';
		if (m?.sender === 'vendor') return 'To me';
		return '';
	};

	const agentToLine = (m) => {
		const toName = m?.toName ?? tenant?.name ?? 'Tenant';
		const toEmail = m?.toEmail ?? tenant?.email ?? '';
		if (!toEmail) return `To ${toName}`;
		return `To ${toName} <${toEmail}>`;
	};

	const displayFromName = (m) => {
		if (m?.sender === 'vendor') return m?.fromName ?? 'Vendor';
		return senderLabel(m?.sender);
	};

	const snippet = (value) => {
		if (!value) return '';
		return value.replace(/\s+/g, ' ').trim().slice(0, 110);
	};

	onMount(() => {
		if (messages?.length && expandedIds.length === 0) {
			expandedIds = [messages[messages.length - 1].id];
		}
	});

	const toggleExpanded = (id) => {
		if (!id) return;
		if (expandedIds.includes(id)) {
			expandedIds = expandedIds.filter((value) => value !== id);
			return;
		}
		expandedIds = [...expandedIds, id];
	};
</script>

<div class="space-y-3">
	{#if !messages?.length}
		<div class="mt-3 text-sm text-neutral-500">No messages yet.</div>
	{:else}
		<div class="space-y-2">
			{#each messages as m, idx (m.id)}
				{@const prev = idx > 0 ? messages[idx - 1] : null}
				{#if prev?.channel && m?.channel && prev.channel !== m.channel}
					<div class="my-4 border-t border-neutral-200/70"></div>
				{/if}
				{@const isOpen = expandedIds.includes(m.id)}
				<div
					class={`w-full rounded-lg border border-neutral-200/70 bg-white transition ${
						isOpen ? '' : 'hover:border-neutral-300/70 hover:bg-neutral-50'
					}`}
				>
					<button
						class="w-full px-5 py-4 text-left"
						on:click={() => toggleExpanded(m.id)}
						type="button"
					>
						<div class="flex items-start justify-between gap-6">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<div class="truncate text-sm font-medium text-neutral-900">
										{displayFromName(m)}
									</div>
									{#if !isOpen}
										<div class="truncate text-sm text-neutral-500">{snippet(m.message)}</div>
									{/if}
								</div>
								{#if isOpen}
									<div class="mt-1 text-sm text-neutral-500">
										{m.sender === 'agent' ? agentToLine(m) : senderMeta(m)}
									</div>
								{/if}
							</div>
							<div class="flex items-center gap-3 text-xs text-neutral-400">
								<span>{formatTime(m.timestamp)}</span>
							</div>
						</div>
					</button>

					{#if isOpen}
						<div class="px-5 pb-5">
							<div class="pt-4">
								<div class="text-sm leading-relaxed whitespace-pre-wrap text-neutral-800">
									{m.message}
								</div>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
