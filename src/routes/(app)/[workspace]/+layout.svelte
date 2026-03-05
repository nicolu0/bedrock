<script>
	// @ts-nocheck
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { propertiesCache, primePropertiesCache } from '$lib/stores/propertiesCache.js';
	import { unitsCache, primeUnitsCache } from '$lib/stores/unitsCache.js';
	import { goto } from '$app/navigation';
	import {
		ensureIssuesCache,
		issuesCache,
		applyIssueInsert,
		applyIssueDelete,
		updateIssueStatusInListCache,
		updateIssueFieldsInListCache
	} from '$lib/stores/issuesCache';
	import {
		ensureNotificationsCache,
		addNotificationToCache,
		updateNotificationInCache
	} from '$lib/stores/notificationsCache';
	import { ensurePeopleMembersCache } from '$lib/stores/peopleMembersCache';
	import {
		ensureActivityCache,
		applyMessageDelta,
		applyDraftDelta,
		removeMessageFromCache,
		removeDraftFromCache
	} from '$lib/stores/activityCache';
	import {
		updateIssueStatusInDetailCache,
		updateIssueFieldsInDetailCache
	} from '$lib/stores/issueDetailCache.js';
	import {
		ensureActivityLogsCache,
		applyActivityLogDelta,
		removeActivityLogFromCache
	} from '$lib/stores/activityLogsCache';
	import { pageReady } from '$lib/stores/pageReady';
	import { supabase } from '$lib/supabaseClient.js';
	export let data;

	let appMounted = false;
	onMount(() => {
		appMounted = true;
	});
	$: pageVisible = appMounted && $pageReady;
	$: workspaceSlug = $page.params.workspace;
	$: isIssueRoute = $page.url.pathname.includes('/issue/');
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: isSettingsRoute = $page.url.pathname.startsWith(`${basePath}/settings`);
	$: currentPath = $page.url.pathname;
	$: activeItem = [...navItems, propertiesItem, settingsItem].find(
		(item) =>
			currentPath === `${basePath}/${item.href}` ||
			currentPath.startsWith(`${basePath}/${item.href}/`)
	);
	$: properties =
		$propertiesCache.workspace === workspaceSlug && $propertiesCache.data != null
			? $propertiesCache.data
			: null;

	let _primedPropertiesForWorkspace = null;
	$: if (browser && data.properties && _primedPropertiesForWorkspace !== workspaceSlug) {
		_primedPropertiesForWorkspace = workspaceSlug;
		const _ws = workspaceSlug;
		const prime = (list) => {
			const cache = get(propertiesCache);
			if (!cache.data || cache.workspace !== _ws) {
				primePropertiesCache(_ws, Array.isArray(list) ? list : []);
			}
		};
		if (data.properties instanceof Promise) {
			data.properties.then(prime);
		} else {
			prime(data.properties);
		}
	}

	let _primedUnitsForWorkspace = null;
	$: if (browser && data.units && _primedUnitsForWorkspace !== workspaceSlug) {
		_primedUnitsForWorkspace = workspaceSlug;
		const _ws = workspaceSlug;
		const prime = (list) => {
			const cache = get(unitsCache);
			if (!cache.data || cache.workspace !== _ws) {
				primeUnitsCache(_ws, Array.isArray(list) ? list : []);
			}
		};
		if (data.units instanceof Promise) {
			data.units.then(prime);
		} else {
			prime(data.units);
		}
	}
	const navItems = [
		{ id: 'inbox', label: 'Inbox', href: 'inbox' },
		{ id: 'my-issues', label: 'My issues', href: 'my-issues' },
		{ id: 'people', label: 'People', href: 'people' }
	];
	const propertiesItem = { id: 'properties', label: 'Properties', href: 'properties' };
	const settingsItem = { id: 'settings', label: 'Settings', href: 'settings' };
	let propertiesOpen = true;

	const slugify = (value) => {
		if (!value) return 'property';
		const base = value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
		return base || 'property';
	};

	$: if (browser && workspaceSlug) {
		ensureIssuesCache(workspaceSlug);
		ensureNotificationsCache(workspaceSlug);
		ensurePeopleMembersCache(workspaceSlug);
		ensureActivityCache(workspaceSlug);
		ensureActivityLogsCache(workspaceSlug);
	}

	$: workspaceId = data?.workspace?.id;
	$: userId = data?.userId;

	let _workspaceChannel = null;
	let _channelWorkspaceId = null;

	$: if (browser && workspaceId && workspaceSlug && workspaceId !== _channelWorkspaceId) {
		_channelWorkspaceId = workspaceId;
		if (_workspaceChannel) supabase.removeChannel(_workspaceChannel);

		_workspaceChannel = supabase
			.channel(`workspace-delta-${workspaceId}`)

			// issues INSERT — apply delta, resolve unit/property names for root issues
			.on(
				'postgres_changes',
				{
					event: 'INSERT',
					schema: 'public',
					table: 'issues',
					filter: `workspace_id=eq.${workspaceId}`
				},
				async ({ new: issue }) => {
					const cacheStateOnInsert = get(issuesCache);
					console.log('[RT INSERT] received issue', issue.id, issue.name, {
						workspaceSlug,
						cacheDataNull: cacheStateOnInsert.data === null,
						cacheLoading: cacheStateOnInsert.loading,
						cacheIssueCount: cacheStateOnInsert.data?.issues?.length ?? 'N/A'
					});
					if (issue.parent_id) {
						const parent = get(issuesCache).data?.issues?.find((i) => i.id === issue.parent_id);
						applyIssueInsert(issue, {
							unitName: parent?.unit,
							propertyName: parent?.property,
							parentTitle: parent?.title
						});
					} else {
						const { data: unit } = await supabase
							.from('units')
							.select('name, properties(name)')
							.eq('id', issue.unit_id)
							.maybeSingle();
						applyIssueInsert(issue, {
							unitName: unit?.name ?? 'Unknown',
							propertyName: unit?.properties?.name ?? 'Unknown'
						});
					}
					const afterApply = get(issuesCache);
					const issueInCacheAfterApply = (afterApply.data?.issues ?? []).some(
						(i) => i.id === issue.id
					);
					console.log('[RT INSERT] after applyIssueInsert', {
						issueInCache: issueInCacheAfterApply,
						cacheDataNull: afterApply.data === null,
						cacheLoading: afterApply.loading
					});
					// Fallback: if the cache wasn't ready, applyIssueInsert was a no-op.
					// Wait for any in-flight fetch, then force-refresh if the issue is still missing.
					if (!issueInCacheAfterApply) {
						console.log('[RT INSERT] issue missing after apply — awaiting ensureIssuesCache...');
						await ensureIssuesCache(workspaceSlug);
						const afterEnsure = get(issuesCache);
						const issueInCacheAfterEnsure = (afterEnsure.data?.issues ?? []).some(
							(i) => i.id === issue.id
						);
						console.log('[RT INSERT] after ensureIssuesCache', {
							issueInCache: issueInCacheAfterEnsure,
							cacheIssueCount: afterEnsure.data?.issues?.length ?? 'N/A',
							fetchedAt: afterEnsure.fetchedAt
						});
						if (!issueInCacheAfterEnsure) {
							console.log('[RT INSERT] still missing — calling ensureIssuesCache({ force: true })');
							ensureIssuesCache(workspaceSlug, { force: true });
						}
					}
				}
			)

			// issues UPDATE — sync status and name to all open caches
			.on(
				'postgres_changes',
				{
					event: 'UPDATE',
					schema: 'public',
					table: 'issues',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ new: issue }) => {
					updateIssueFieldsInListCache(issue.id, { name: issue.name, status: issue.status });
					updateIssueFieldsInDetailCache(issue.id, { name: issue.name, status: issue.status });
				}
			)

			// issues DELETE
			.on(
				'postgres_changes',
				{
					event: 'DELETE',
					schema: 'public',
					table: 'issues',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ old: issue }) => applyIssueDelete(issue.id)
			)

			// notifications INSERT — fetch full row with joins, add to cache
			.on(
				'postgres_changes',
				{
					event: 'INSERT',
					schema: 'public',
					table: 'notifications',
					filter: `user_id=eq.${userId}`
				},
				async ({ new: notification }) => {
					const { data: full } = await supabase
						.from('notifications')
						.select(
							'*, issues(id, name, unit_id, issue_number, readable_id, units(id, name, properties(id, name)))'
						)
						.eq('id', notification.id)
						.maybeSingle();
					if (full) addNotificationToCache(full);
				}
			)

			// messages INSERT/UPDATE/DELETE — apply delta to activityCache workspace-wide
			.on(
				'postgres_changes',
				{
					event: 'INSERT',
					schema: 'public',
					table: 'messages',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ new: msg }) => applyMessageDelta(msg)
			)
			.on(
				'postgres_changes',
				{
					event: 'UPDATE',
					schema: 'public',
					table: 'messages',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ new: msg }) => applyMessageDelta(msg)
			)
			.on(
				'postgres_changes',
				{
					event: 'DELETE',
					schema: 'public',
					table: 'messages',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ old: msg }) => removeMessageFromCache(msg)
			)

			// email_drafts INSERT/UPDATE/DELETE — apply delta to activityCache workspace-wide
			.on(
				'postgres_changes',
				{
					event: 'INSERT',
					schema: 'public',
					table: 'email_drafts',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ new: draft }) => applyDraftDelta(draft)
			)
			.on(
				'postgres_changes',
				{
					event: 'UPDATE',
					schema: 'public',
					table: 'email_drafts',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ new: draft }) => applyDraftDelta(draft)
			)
			.on(
				'postgres_changes',
				{
					event: 'DELETE',
					schema: 'public',
					table: 'email_drafts',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ old: draft }) => removeDraftFromCache(draft)
			)

			// activity_logs INSERT/UPDATE/DELETE — apply delta to activityLogsCache workspace-wide
			.on(
				'postgres_changes',
				{
					event: 'INSERT',
					schema: 'public',
					table: 'activity_logs',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ new: log }) => applyActivityLogDelta(log)
			)
			.on(
				'postgres_changes',
				{
					event: 'UPDATE',
					schema: 'public',
					table: 'activity_logs',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ new: log }) => applyActivityLogDelta(log)
			)
			.on(
				'postgres_changes',
				{
					event: 'DELETE',
					schema: 'public',
					table: 'activity_logs',
					filter: `workspace_id=eq.${workspaceId}`
				},
				({ old: log }) => removeActivityLogFromCache(log)
			)

			// notifications UPDATE — sync is_read changes
			.on(
				'postgres_changes',
				{
					event: 'UPDATE',
					schema: 'public',
					table: 'notifications',
					filter: `user_id=eq.${userId}`
				},
				({ new: notification }) => updateNotificationInCache(notification)
			)

			.subscribe();
	}

	onDestroy(() => {
		if (_workspaceChannel) supabase.removeChannel(_workspaceChannel);
	});
</script>

{#if isSettingsRoute}
	<slot />
{:else}
	<div class="h-screen bg-white text-neutral-900">
		<div class="flex h-screen flex-col md:flex-row">
			<aside class="flex h-screen w-1/6 flex-col border-r border-neutral-200 bg-neutral-50/80">
				<div
					class="flex h-full min-h-0 flex-col transition-opacity duration-150"
					class:opacity-0={!pageVisible}
				>
					<div class="flex flex-1 flex-col space-y-6 px-2 pt-4">
						<div class="flex items-center justify-between px-2 text-neutral-700">
							<div class="flex items-center gap-2">
								<div class="h-4.5 w-4.5 rounded-sm bg-neutral-700"></div>
								<span class="max-w-[120px] truncate text-sm text-neutral-700">
									{data?.workspace?.name ?? ''}
								</span>
							</div>
							<a
								href={`${basePath}/search`}
								class="rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="12"
									height="12"
									fill="currentColor"
									class="bi bi-search"
									viewBox="0 0 16 16"
								>
									<path
										d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"
									/>
								</svg>
							</a>
						</div>
						<div class="flex flex-1 flex-col gap-1 pb-4">
							{#each navItems as item}
								<a
									href={`${basePath}/${item.href}`}
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-normal transition ${currentPath === `${basePath}/${item.href}` || currentPath.startsWith(`${basePath}/${item.href}/`) ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
								>
									<span class="truncate">{item.label}</span>
								</a>
							{/each}
							<div class="mt-2">
								<button
									type="button"
									class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-neutral-400 transition hover:bg-neutral-100"
									on:click={() => (propertiesOpen = !propertiesOpen)}
								>
									<span class="truncate">{propertiesItem.label}</span>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="14"
										height="14"
										fill="currentColor"
										class={`transition ${propertiesOpen ? '' : '-rotate-90'}`}
										viewBox="0 0 16 16"
									>
										<path
											d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
										/>
									</svg>
								</button>
								{#if propertiesOpen}
									<div class="mt-1 space-y-1">
										<a
											href={`${basePath}/${propertiesItem.href}`}
											class={`flex w-full items-center rounded-md px-2 py-1.5 text-sm font-normal transition ${currentPath === `${basePath}/${propertiesItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
										>
											<span>All properties</span>
										</a>
										{#if properties !== null}
											{#if properties?.length}
												{#each properties as property}
													<a
														href={`${basePath}/${propertiesItem.href}/${slugify(property.name)}`}
														class={`flex w-full items-center rounded-md px-2 py-1.5 text-sm font-normal transition ${currentPath.startsWith(`${basePath}/${propertiesItem.href}/${slugify(property.name)}`) ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
													>
														<span class="truncate">{property.name}</span>
													</a>
												{/each}
											{/if}
										{:else}
											<div class="px-2 py-1.5 text-xs text-neutral-400">Loading properties...</div>
										{/if}
									</div>
								{/if}
							</div>
							<div class="mt-auto">
								<button
									type="button"
									on:click={() => goto(`${basePath}/${settingsItem.href}`)}
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${currentPath === `${basePath}/${settingsItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="14"
										height="14"
										fill="currentColor"
										viewBox="0 0 16 16"
										class="shrink-0"
									>
										<path
											d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492M5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0"
										/>
										<path
											d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.375l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115z"
										/>
									</svg>
									<span class="truncate">{settingsItem.label}</span>
								</button>
							</div>
						</div>
					</div>
				</div>
			</aside>
			<section class="flex-1 overflow-y-auto">
				<div
					class="h-full w-full"
					class:transition-opacity={!isIssueRoute}
					class:duration-150={!isIssueRoute}
					class:opacity-0={!isIssueRoute && !pageVisible}
				>
					<slot />
				</div>
			</section>
		</div>
	</div>
{/if}
