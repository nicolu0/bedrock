<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { goto, invalidate } from '$app/navigation';
	import { browser } from '$app/environment';
	import {
		notificationsCache,
		primeNotificationsCache
	} from '$lib/stores/notificationsCache.js';
	import { membersCache, primeMembersCache } from '$lib/stores/membersCache.js';

	export let data;

	let filter = 'All';
	let reassignOpen = {};
	let reassignValue = {};
	let loadError = false;
	$: isAdmin = data.workspace?.admin_user_id === data.currentUserId;

	$: workspaceSlug = $page.params.workspace;

	// Derive display data from cache (null = not yet cached)
	$: notifications =
		$notificationsCache.workspace === workspaceSlug &&
		$notificationsCache.data?.notifications != null
			? $notificationsCache.data.notifications
			: null;
	$: members =
		$membersCache.workspace === workspaceSlug && $membersCache.data != null
			? $membersCache.data
			: [];

	$: filtered =
		filter === 'Unread' ? (notifications ?? []).filter((n) => !n.is_read) : notifications ?? [];

	// Prime cache from server data — re-runs after invalidate() triggers a fresh load
	$: if (browser && data.notifications && data.members) {
		Promise.all([data.notifications, data.members])
			.then(([n, m]) => {
				primeNotificationsCache(workspaceSlug, { notifications: n, members: m });
				primeMembersCache(workspaceSlug, m);
			})
			.catch(() => {
				loadError = true;
			});
	}

	const slugify = (value) => {
		if (!value) return 'issue';
		return value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
	};

	function timeAgo(dateStr) {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60000);
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
		if (!n.is_read) {
			// Optimistic update
			notificationsCache.update((state) => ({
				...state,
				data: state.data
					? {
							...state.data,
							notifications: state.data.notifications.map((notif) =>
								notif.id === n.id ? { ...notif, is_read: true } : notif
							)
						}
					: state.data
			}));
			const fd = new FormData();
			fd.append('id', n.id);
			await fetch('?/markRead', { method: 'POST', body: fd });
			invalidate('app:notifications');
		}
		const issue = n.issues;
		if (issue?.id) {
			goto(`/${workspaceSlug}/issue/${issue.id}/${slugify(issue.name)}`);
		}
	}

	async function handleApprove(n) {
		const assigneeId = n.meta?.suggested_assignee_id;
		if (!assigneeId) return;
		// Optimistic update
		notificationsCache.update((state) => ({
			...state,
			data: state.data
				? {
						...state.data,
						notifications: state.data.notifications.map((notif) =>
							notif.id === n.id ? { ...notif, is_read: true, requires_action: false } : notif
						)
					}
				: state.data
		}));
		const fd = new FormData();
		fd.append('notif_id', n.id);
		fd.append('issue_id', n.issues?.id ?? '');
		fd.append('assignee_id', assigneeId);
		await fetch('?/approveAssignment', { method: 'POST', body: fd });
		invalidate('app:notifications');
	}

	async function handleReassignConfirm(n) {
		const assigneeId = reassignValue[n.id];
		if (!assigneeId) return;
		// Optimistic update
		notificationsCache.update((state) => ({
			...state,
			data: state.data
				? {
						...state.data,
						notifications: state.data.notifications.map((notif) =>
							notif.id === n.id ? { ...notif, is_read: true, requires_action: false } : notif
						)
					}
				: state.data
		}));
		reassignOpen[n.id] = false;
		const fd = new FormData();
		fd.append('notif_id', n.id);
		fd.append('issue_id', n.issues?.id ?? '');
		fd.append('assignee_id', assigneeId);
		await fetch('?/approveAssignment', { method: 'POST', body: fd });
		invalidate('app:notifications');
	}
</script>

<div>
	<div class="border-b border-neutral-100 px-6 py-2">
		<h1 class="text-sm font-normal text-neutral-700">Inbox</h1>
	</div>

	<div class="flex items-center gap-2 px-6 py-2">
		{#each ['All', 'Unread'] as tab}
			<button
				class={`rounded-md border px-2.5 py-1 text-xs transition ${
					filter === tab
						? 'border-neutral-200 bg-neutral-100 text-neutral-700'
						: 'border-transparent text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700'
				}`}
				type="button"
				on:click={() => (filter = tab)}
			>
				{tab}
			</button>
		{/each}
	</div>

	{#if notifications !== null}
		{#if filtered.length === 0}
			<div class="px-6 py-8 text-sm text-neutral-400">
				{filter === 'Unread' ? 'No unread notifications.' : 'No notifications yet.'}
			</div>
		{:else}
			<div>
				{#each filtered as n}
					{#if n.requires_action && isAdmin}
						<!-- Assignment suggestion — actionable card -->
						<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
						<div
							class="w-full cursor-pointer border-b border-neutral-100 px-6 py-3 text-left transition hover:bg-stone-50 last:border-b-0"
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
									<div class="mt-0.5 flex items-center justify-between gap-3">
										<p class="truncate text-xs text-neutral-500">{n.body}</p>
										<span class="flex-shrink-0 text-xs text-neutral-400">{timeAgo(n.created_at)}</span>
									</div>
									<div class="mt-2 flex items-center gap-2">
										<button
											class="rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-white transition hover:bg-neutral-700"
											type="button"
											on:click|stopPropagation={() => handleApprove(n)}
										>
											Approve
										</button>
										<button
											class="rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600 transition hover:bg-neutral-50"
											type="button"
											on:click|stopPropagation={() => {
												reassignOpen[n.id] = !reassignOpen[n.id];
												if (!reassignValue[n.id]) {
													const others = members.filter(
														(m) => m.user_id !== n.meta?.suggested_assignee_id
													);
													reassignValue[n.id] = others[0]?.user_id ?? '';
												}
											}}
										>
											Reassign ▾
										</button>
									</div>
									{#if reassignOpen[n.id]}
										<div class="mt-2 flex items-center gap-2">
											<select
												class="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-700"
												bind:value={reassignValue[n.id]}
												on:click|stopPropagation
											>
												{#each members.filter((m) => m.user_id !== n.meta?.suggested_assignee_id) as m}
													<option value={m.user_id}>{m.users?.name ?? m.user_id}</option>
												{/each}
											</select>
											<button
												class="rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-white transition hover:bg-neutral-700"
												type="button"
												on:click|stopPropagation={() => handleReassignConfirm(n)}
											>
												Assign
											</button>
										</div>
									{/if}
								</div>
							</div>
						</div>
					{:else}
						<!-- Standard notification row -->
						<button
							class="w-full border-b border-neutral-100 px-6 py-3 text-left transition hover:bg-stone-50 last:border-b-0"
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
									<div class="mt-0.5 flex items-center justify-between gap-3">
										<p class="truncate text-xs text-neutral-500">{n.body}</p>
										<span class="flex-shrink-0 text-xs text-neutral-400"
											>{timeAgo(n.created_at)}</span
										>
									</div>
								</div>
							</div>
						</button>
					{/if}
				{/each}
			</div>
		{/if}
	{:else if loadError}
		<div class="px-6 py-8 text-sm text-neutral-400">Failed to load notifications.</div>
	{:else}
		<!-- First visit: skeleton while server data loads -->
		<div class="divide-y divide-neutral-100">
			{#each Array(5) as _, i}
				<div class="flex items-start gap-3 px-6 py-3">
					<div class="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full shimmer"></div>
					<div class="flex-1 space-y-2">
						<div class="flex items-center justify-between gap-3">
							<div class="shimmer h-3 rounded" style="width: {i % 2 === 0 ? '45%' : '55%'}"></div>
							<div class="shimmer h-3 w-20 rounded"></div>
						</div>
						<div class="shimmer h-3 rounded" style="width: {i % 3 === 0 ? '70%' : '80%'}"></div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	@keyframes shimmer {
		0% { background-position: -200% 0; }
		100% { background-position: 200% 0; }
	}
	.shimmer {
		background: linear-gradient(90deg, #f5f5f4 25%, #e8e5e3 50%, #f5f5f4 75%);
		background-size: 200% 100%;
		animation: shimmer 1.6s ease-in-out infinite;
	}
</style>
