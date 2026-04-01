<script>
	// @ts-nocheck
	import { page } from '$app/stores';

	import { browser } from '$app/environment';
	import {
		notificationsCache,
		updateNotificationInCache,
		primeNotificationsCache
	} from '$lib/stores/notificationsCache';
	import SidebarButton from '$lib/components/SidebarButton.svelte';
	import { openChatPanel, openIssuePanel, toggleChatPanel } from '$lib/stores/rightPanel.js';
	import { onMount, onDestroy } from 'svelte';

	export let data;

	let filter = 'All';
	let unreadSnapshot = null;
	let selectedNotification = null;
	let localReadIds = new Set();
	let localResolvedIds = new Set();

	$: _resolvedNotifications =
		$notificationsCache?.workspace === $page.params.workspace && $notificationsCache?.data
			? $notificationsCache.data
			: null;
	$: {
		if (data.notificationsData instanceof Promise) {
			const loadStartedAt = Date.now();
			data.notificationsData.then((d) => {
				if (browser) primeNotificationsCache($page.params.workspace, d, loadStartedAt);
			});
		} else if (data.notificationsData) {
			if (browser) primeNotificationsCache($page.params.workspace, data.notificationsData);
		}
	}

	let _resolvedActivity = null,
		_resolvedLogs = null;
	$: {
		if (data.activityBundle instanceof Promise) {
			data.activityBundle.then((d) => {
				if (d) {
					_resolvedActivity = d.activityData;
					_resolvedLogs = d.activityLogsData;
				}
			});
		} else if (data.activityBundle) {
			_resolvedActivity = data.activityBundle.activityData;
			_resolvedLogs = data.activityBundle.activityLogsData;
		}
	}

	function setFilter(tab) {
		unreadSnapshot =
			tab === 'Unread'
				? new Set(
						(effectiveNotifications ?? [])
							.filter((n) => !n.is_read && !n.is_resolved)
							.map((n) => n.id)
					)
				: null;
		filter = tab;
		selectedNotification = null;
	}

	$: workspaceSlug = $page.params.workspace;

	$: notifications = _resolvedNotifications?.notifications ?? [];

	// Patch is_read and is_resolved optimistically from local sets
	$: effectiveNotifications = notifications.map((n) => ({
		...n,
		is_read: n.is_read || localReadIds.has(n.id),
		is_resolved: n.is_resolved || localResolvedIds.has(n.id)
	}));

	// Reset local optimistic sets only when notification IDs actually change
	let _prevNotifIds = '';
	$: {
		const ids = (notifications ?? []).map((n) => n.id).join(',');
		if (ids !== _prevNotifIds) {
			_prevNotifIds = ids;
			localReadIds = new Set();
			localResolvedIds = new Set();
		}
	}

	$: filtered =
		filter === 'Unread'
			? effectiveNotifications.filter((n) => unreadSnapshot?.has(n.id) && !n.is_resolved)
			: filter === 'Resolved'
				? effectiveNotifications.filter((n) => n.is_resolved)
				: /* All */ effectiveNotifications.filter((n) => !n.is_resolved);

	function resolveAndAdvance() {
		if (!selectedNotification) return;
		const idx = filtered.findIndex((n) => n.id === selectedNotification.id);
		const next = filtered[idx + 1] ?? filtered[idx - 1] ?? null;
		localResolvedIds = new Set([...localResolvedIds, selectedNotification.id]);
		updateNotificationInCache({ id: selectedNotification.id, is_resolved: true });
		if (next) handleClick(next);
		else {
			selectedNotification = null;
			openChatPanel();
		}
	}

	const handlePanelClose = () => {
		selectedNotification = null;
		openChatPanel();
	};

	let _resolvedVendors = [];
	$: {
		if (data.vendors instanceof Promise) {
			data.vendors.then((v) => {
				_resolvedVendors = v ?? [];
			});
		} else {
			_resolvedVendors = data.vendors ?? [];
		}
	}
	$: vendors = _resolvedVendors;

	let _resolvedPeople = [];
	$: {
		if (data.people instanceof Promise) {
			data.people.then((p) => {
				_resolvedPeople = p ?? [];
			});
		} else {
			_resolvedPeople = data.people ?? [];
		}
	}
	$: people = _resolvedPeople;

	let _now = Date.now();
	let _ticker;
	onMount(() => {
		_ticker = setInterval(() => {
			_now = Date.now();
		}, 30_000);
	});
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
		openIssuePanel({
			issueId: n.issues?.id,
			seedIssue: n.issues,
			activityData: _resolvedActivity,
			activityLogsData: _resolvedLogs,
			vendors,
			allIssues: [],
			onClose: handlePanelClose,
			onResolved: resolveAndAdvance
		});
		if (!n.is_read && !localReadIds.has(n.id)) {
			localReadIds = new Set([...localReadIds, n.id]);
			updateNotificationInCache({ id: n.id, is_read: true });
			fetch('/api/notifications/mark-read', {
				method: 'POST',
				keepalive: true,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: n.id })
			});
		}
	}
</script>

<svelte:window
	on:keydown={(e) => {
		if (e.key === 'Escape' && selectedNotification) {
			selectedNotification = null;
			openChatPanel();
		}
	}}
/>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex items-center justify-between border-b border-neutral-200 py-2.5 pr-5 pl-6">
		<h1 class="text-sm font-normal text-neutral-700">Inbox</h1>
		<div class="flex items-center gap-2">
			<SidebarButton
				onClick={() => {
					selectedNotification = null;
					toggleChatPanel();
				}}
			/>
		</div>
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

	<div class="flex-1 overflow-y-auto">
		{#if _resolvedNotifications === null}
			<div>
				{#each { length: 4 } as _}
					<div class="flex items-start gap-3 border-b border-neutral-100 px-6 py-3">
						<div class="skeleton mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"></div>
						<div class="flex-1 space-y-2">
							<div class="skeleton h-4 w-3/4"></div>
							<div class="skeleton h-3 w-1/2"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else if filtered.length === 0}
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
</div>
