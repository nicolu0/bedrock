<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	export let data;

	let filter = 'All';

	$: workspaceSlug = $page.params.workspace;

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
			const fd = new FormData();
			fd.append('id', n.id);
			await fetch('?/markRead', { method: 'POST', body: fd });
			n.is_read = true;
			notifications = notifications;
		}
		const issue = n.issues;
		if (issue?.id) {
			goto(`/${workspaceSlug}/issue/${issue.id}/${slugify(issue.name)}`);
		}
	}

	async function handleApprove(n) {
		const assigneeId = n.meta?.suggested_assignee_id;
		if (!assigneeId) return;
		const fd = new FormData();
		fd.append('notif_id', n.id);
		fd.append('issue_id', n.issues?.id ?? '');
		fd.append('assignee_id', assigneeId);
		// Optimistic update
		n.is_read = true;
		n.requires_action = false;
		notifications = notifications;
		await fetch('?/approveAssignment', { method: 'POST', body: fd });
		if (n.issues?.id) {
			goto(`/${workspaceSlug}/issue/${n.issues.id}/${slugify(n.issues.name)}`);
		}
	}

	async function handleReassignConfirm(n) {
		const assigneeId = reassignValue[n.id];
		if (!assigneeId) return;
		const fd = new FormData();
		fd.append('notif_id', n.id);
		fd.append('issue_id', n.issues?.id ?? '');
		fd.append('assignee_id', assigneeId);
		// Optimistic update
		n.is_read = true;
		n.requires_action = false;
		reassignOpen[n.id] = false;
		notifications = notifications;
		await fetch('?/approveAssignment', { method: 'POST', body: fd });
		if (n.issues?.id) {
			goto(`/${workspaceSlug}/issue/${n.issues.id}/${slugify(n.issues.name)}`);
		}
	}

	let notifications = [];
	let members = [];
	let reassignOpen = {};
	let reassignValue = {};

	$: filteredNotifications =
		filter === 'Unread' ? notifications.filter((n) => !n.is_read) : notifications;
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

	{#await data.notifications}
		<div class="divide-y divide-neutral-100">
			{#each Array(4) as _}
				<div class="flex items-start gap-3 px-6 py-3">
					<div class="mt-1.5 h-2 w-2 rounded-full bg-neutral-200"></div>
					<div class="flex-1 space-y-1.5">
						<div class="h-3 w-48 rounded bg-neutral-100"></div>
						<div class="h-3 w-72 rounded bg-neutral-100"></div>
					</div>
				</div>
			{/each}
		</div>
	{:then resolved}
		{#if (notifications = resolved) && (members = data.members) !== undefined || true}
			{#if filteredNotifications.length === 0}
				<div class="px-6 py-8 text-sm text-neutral-400">
					{filter === 'Unread' ? 'No unread notifications.' : 'No notifications yet.'}
				</div>
			{:else}
				<div class="divide-y divide-neutral-100">
					{#each filteredNotifications as n}
						{#if n.requires_action && data.isAdmin}
							<!-- Assignment suggestion — actionable card -->
							<div class="w-full px-6 py-3 text-left transition hover:bg-stone-50">
								<div class="flex items-start gap-3">
									<div class="mt-1.5 flex-shrink-0">
										{#if !n.is_read}
											<span class="block h-2 w-2 rounded-full bg-blue-500"></span>
										{:else}
											<span class="block h-2 w-2"></span>
										{/if}
									</div>
									<div class="min-w-0 flex-1">
										<button
											class="w-full text-left"
											type="button"
											on:click={() => handleClick(n)}
										>
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
										</button>
										<div class="mt-2 flex items-center gap-2">
											<button
												class="rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-white transition hover:bg-neutral-700"
												type="button"
												on:click={() => handleApprove(n)}
											>
												Approve
											</button>
											<button
												class="rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600 transition hover:bg-neutral-50"
												type="button"
												on:click={() => {
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
												>
													{#each members.filter((m) => m.user_id !== n.meta?.suggested_assignee_id) as m}
														<option value={m.user_id}>{m.users?.name ?? m.user_id}</option>
													{/each}
												</select>
												<button
													class="rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-white transition hover:bg-neutral-700"
													type="button"
													on:click={() => handleReassignConfirm(n)}
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
								class="w-full px-6 py-3 text-left transition hover:bg-stone-50"
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
		{/if}
	{:catch}
		<div class="px-6 py-8 text-sm text-neutral-400">Failed to load notifications.</div>
	{/await}
</div>
