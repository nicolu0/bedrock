<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { invalidate } from '$app/navigation';
	import IssuePanel from '$lib/components/IssuePanel.svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { onMount, onDestroy } from 'svelte';

	export let data;

	let filter = 'All';
	let unreadSnapshot = null;
	let selectedNotification = null;
	let localReadIds = new Set();
	let localResolvedIds = new Set();

	function setFilter(tab) {
		unreadSnapshot = tab === 'Unread'
			? new Set((effectiveNotifications ?? []).filter((n) => !n.is_read && !n.is_resolved).map((n) => n.id))
			: null;
		filter = tab;
		selectedNotification = null;
	}

	$: workspaceSlug = $page.params.workspace;

	$: notifications = data.notificationsData?.notifications ?? [];

	// Patch is_read and is_resolved optimistically from local sets
	$: effectiveNotifications = notifications.map((n) => ({
		...n,
		is_read: n.is_read || localReadIds.has(n.id),
		is_resolved: n.is_resolved || localResolvedIds.has(n.id)
	}));

	// Reset local optimistic sets when server data changes
	$: if (notifications) {
		localReadIds = new Set();
		localResolvedIds = new Set();
	}

	$: filtered =
		filter === 'Unread'   ? effectiveNotifications.filter((n) => unreadSnapshot?.has(n.id) && !n.is_resolved) :
		filter === 'Resolved' ? effectiveNotifications.filter((n) => n.is_resolved) :
		/* All */               effectiveNotifications.filter((n) => !n.is_resolved);

	function resolveAndAdvance() {
		if (!selectedNotification) return;
		const idx = filtered.findIndex((n) => n.id === selectedNotification.id);
		const next = filtered[idx + 1] ?? filtered[idx - 1] ?? null;
		localResolvedIds = new Set([...localResolvedIds, selectedNotification.id]);
		if (next) handleClick(next); else selectedNotification = null;
		invalidate('app:notifications');
	}

	$: vendors = data.vendors ?? [];

	let _now = Date.now();
	let _ticker;
	onMount(() => { _ticker = setInterval(() => { _now = Date.now(); }, 30_000); });
	onDestroy(() => clearInterval(_ticker));

	function timeAgo(dateStr, now) {
		const diff = now - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins} ${mins === 1 ? 'min' : 'mins'} ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'} ago`;
		const days = Math.floor(hrs / 24);
		return `${days} ${days === 1 ? 'day' : 'days'} ago`;
	}

	function statusClass(status) {
		if (status === 'in progress') return 'border-sky-500';
		if (status === 'resolved') return 'border-emerald-500';
		if (status === 'escalated') return 'border-amber-500';
		return 'border-neutral-400';
	}

	async function handleClick(n) {
		selectedNotification = n;
		if (!n.is_read && !localReadIds.has(n.id)) {
			localReadIds = new Set([...localReadIds, n.id]);
			fetch('/api/notifications/mark-read', {
				method: 'POST',
				keepalive: true,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: n.id })
			});
		}
	}
</script>

<svelte:window on:keydown={(e) => { if (e.key === 'Escape' && selectedNotification) selectedNotification = null; }} />

<div class="flex h-full overflow-hidden">
	<!-- Notification list -->
	<div
		class="flex-none flex flex-col overflow-y-auto transition-[width] duration-[280ms] ease-out
			{selectedNotification ? 'w-1/2 border-r border-neutral-200' : 'w-full'}"
	>
		<div class="flex items-center border-b border-neutral-200 px-6 py-3">
			<h1 class="text-sm font-normal text-neutral-700">Inbox</h1>
		</div>

		<div class="flex items-center gap-2 px-6 py-2">
			{#each ['All', 'Unread', 'Resolved'] as tab}
				<button
					class={`rounded-md border px-2.5 py-1 text-xs transition ${
						filter === tab
							? 'border-neutral-200 bg-neutral-100 text-neutral-700'
							: 'border-transparent text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700'
					}`}
					type="button"
					on:click={() => setFilter(tab)}
				>
					{tab}
				</button>
			{/each}
		</div>

		{#if filtered.length === 0}
			<div class="px-6 py-8 text-sm text-neutral-400">
				{filter === 'Unread' ? 'No unread notifications.' : 'No notifications yet.'}
			</div>
		{:else}
			<div>
				{#each filtered as n}
					<button
						class="w-full border-b border-neutral-100 px-6 py-3 text-left transition last:border-b-0 focus:outline-none
							{selectedNotification?.id === n.id ? 'bg-stone-100' : 'hover:bg-stone-50'}"
						type="button"
						on:click={() => handleClick(n)}
					>
						<div class="flex items-start gap-3">
							<div class="mt-1.5 flex-shrink-0">
								{#if !n.is_read}
									<span class="block h-2 w-2 rounded-full bg-blue-500"></span>
								{:else}
									<span class="block h-2 w-2"></span>
								{/if}
							</div>
							<div class="min-w-0 flex-1">
								<!-- Title row -->
								<div class="flex items-center justify-between gap-3">
									<span class="truncate text-sm font-medium text-neutral-800">{n.title}</span>
									<div class="flex flex-shrink-0 items-center gap-2">
										{#if n.issues?.units}
											<div
												class="inline-flex items-center overflow-hidden rounded-full border border-neutral-200 bg-white text-xs text-neutral-500"
											>
												{#if n.issues.units.properties?.name}
													<span class="px-2 py-0.5">{n.issues.units.properties.name}</span>
													<span class="border-l border-neutral-200 px-2 py-0.5"
														>{n.issues.units.name}</span
													>
												{:else}
													<span class="px-2 py-0.5">{n.issues.units.name}</span>
												{/if}
											</div>
										{/if}
										{#if n.issues?.status}
											<span
												class={`h-3 w-3 flex-shrink-0 rounded-full border ${statusClass(n.issues.status)}`}
											></span>
										{/if}
									</div>
								</div>
								<!-- Body + time row -->
								<div class="mt-0.5 flex items-center justify-between gap-3">
									<p class="truncate text-xs text-neutral-500">{n.body}</p>
									<span class="flex-shrink-0 text-xs text-neutral-400"
										>{timeAgo(n.created_at, _now)}</span
									>
								</div>
							</div>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Issue detail panel -->
	{#if selectedNotification}
		<div
			class="flex-none w-1/2 overflow-y-auto"
			in:fly={{ x: 400, duration: 280, easing: cubicOut }}
			out:fly={{ x: 400, duration: 220, easing: cubicOut }}
		>
			<IssuePanel
				issueId={selectedNotification.issues?.id}
				seedIssue={selectedNotification.issues}
				activityData={data.activityData}
				activityLogsData={data.activityLogsData}
				{vendors}
				allIssues={[]}
				on:close={() => (selectedNotification = null)}
				on:resolved={resolveAndAdvance}
			/>
		</div>
	{/if}
</div>

<style>
	@keyframes shimmer {
		0% {
			background-position: -200% 0;
		}
		100% {
			background-position: 200% 0;
		}
	}
	.shimmer {
		background: linear-gradient(90deg, #f5f5f4 25%, #e8e5e3 50%, #f5f5f4 75%);
		background-size: 200% 100%;
		animation: shimmer 1.6s ease-in-out infinite;
	}
</style>
