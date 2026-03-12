<script>
	// @ts-nocheck
	import { onMount, onDestroy, setContext } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import {
		propertiesCache,
		primePropertiesCache,
		ensurePropertiesCache
	} from '$lib/stores/propertiesCache.js';
	import { unitsCache, primeUnitsCache } from '$lib/stores/unitsCache.js';
	import { primeIssuesCache } from '$lib/stores/issuesCache';
	import { primeNotificationsCache } from '$lib/stores/notificationsCache';
	import { primePeopleMembersCache } from '$lib/stores/peopleMembersCache';
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
		primeActivityCache,
		applyMessageDelta,
		applyDraftDelta,
		removeMessageFromCache,
		removeDraftFromCache
	} from '$lib/stores/activityCache';
	import {
		updateIssueStatusInDetailCache,
		updateIssueFieldsInDetailCache,
		primeDetailCacheFromIssuesList
	} from '$lib/stores/issueDetailCache.js';
	import {
		ensureActivityLogsCache,
		primeActivityLogsCache,
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
			const next = Array.isArray(list) ? list : [];
			const nextHasCounts = next.some(
				(item) =>
					Object.prototype.hasOwnProperty.call(item ?? {}, 'unit_count') ||
					Object.prototype.hasOwnProperty.call(item ?? {}, 'issue_count')
			);
			const cacheMissingCounts = (cache.data ?? []).some(
				(item) =>
					!Object.prototype.hasOwnProperty.call(item ?? {}, 'unit_count') &&
					!Object.prototype.hasOwnProperty.call(item ?? {}, 'issue_count')
			);
			if (
				!cache.data ||
				cache.workspace !== _ws ||
				cache.role !== userRole ||
				(nextHasCounts && cacheMissingCounts)
			) {
				primePropertiesCache(_ws, next, userRole);
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
	let _primedIssuesForWorkspace = null;
	$: if (browser && data.issuesData && _primedIssuesForWorkspace !== workspaceSlug) {
		_primedIssuesForWorkspace = workspaceSlug;
		const _ws = workspaceSlug;
		const prime = (d) => {
			if (d?.sections?.length || d?.issues?.length) {
				primeIssuesCache(_ws, d);
				if (d.issues?.length) primeDetailCacheFromIssuesList(d.issues);
			}
		};
		if (data.issuesData instanceof Promise) {
			data.issuesData.then(prime);
		} else {
			prime(data.issuesData);
		}
	}

	let _primedNotificationsForWorkspace = null;
	$: if (browser && data.notificationsData && _primedNotificationsForWorkspace !== workspaceSlug) {
		_primedNotificationsForWorkspace = workspaceSlug;
		const _ws = workspaceSlug;
		const prime = ({ notifications, members }) => {
			primeNotificationsCache(_ws, { notifications, members });
			primePeopleMembersCache(_ws, members);
		};
		if (data.notificationsData instanceof Promise) {
			data.notificationsData.then(prime);
		} else {
			prime(data.notificationsData);
		}
	}

	let _primedActivityForWorkspace = null;
	$: if (browser && data.activityData && _primedActivityForWorkspace !== workspaceSlug) {
		_primedActivityForWorkspace = workspaceSlug;
		const _ws = workspaceSlug;
		if (data.activityData instanceof Promise) {
			data.activityData.then((d) => {
				if (d) primeActivityCache(_ws, d);
			});
		} else if (data.activityData) {
			primeActivityCache(_ws, data.activityData);
		}
	}

	let _primedActivityLogsForWorkspace = null;
	$: if (browser && data.activityLogsData && _primedActivityLogsForWorkspace !== workspaceSlug) {
		_primedActivityLogsForWorkspace = workspaceSlug;
		const _ws = workspaceSlug;
		if (data.activityLogsData instanceof Promise) {
			data.activityLogsData.then((d) => {
				if (d) primeActivityLogsCache(_ws, d);
			});
		} else if (data.activityLogsData) {
			primeActivityLogsCache(_ws, data.activityLogsData);
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
	let sidebarOpen = false;
	const sidebarControl = {
		open: () => (sidebarOpen = true),
		close: () => (sidebarOpen = false)
	};
	setContext('sidebarControl', sidebarControl);

	const slugify = (value) => {
		if (!value) return 'property';
		const base = value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
		return base || 'property';
	};

	$: workspaceId = data?.workspace?.id;
	$: userId = data?.userId;
	$: userRole = data?.role;
	$: canViewPeople = userRole === 'admin' || userRole === 'member';
	$: canViewProperties = userRole === 'admin' || userRole === 'member' || userRole === 'owner';

	$: if (browser && workspaceSlug) {
		if (userRole) {
			ensurePropertiesCache(workspaceSlug, { role: userRole });
		}
		ensureIssuesCache(workspaceSlug);
		ensureNotificationsCache(workspaceSlug);
		if (canViewPeople) ensurePeopleMembersCache(workspaceSlug);
		ensureActivityCache(workspaceSlug);
		ensureActivityLogsCache(workspaceSlug);
	}

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
					const state = get(issuesCache);
					if (state.data && !state.data.issues?.some((i) => i.id === issue.id)) {
						ensureIssuesCache(workspaceSlug, { force: true });
					}
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
					await ensureNotificationsCache(workspaceSlug);
					const { data: full } = await supabase
						.from('notifications')
						.select(
							'*, issues(id, name, unit_id, issue_number, readable_id, units(id, name, properties(id, name)))'
						)
						.eq('id', notification.id)
						.maybeSingle();
					addNotificationToCache(full ?? notification);
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
		<div class="flex h-screen flex-row">
			<div
				class={`fixed inset-0 z-20 bg-neutral-900/40 transition-opacity duration-200 ease-out lg:hidden ${sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
				on:click={() => (sidebarOpen = false)}
			></div>
			<aside
				class={`fixed inset-y-0 left-0 z-30 h-screen w-72 overflow-hidden border-r border-neutral-200 bg-neutral-50/95 shadow-xl transition-transform duration-100 ease-out lg:static lg:z-auto lg:w-1/6 lg:translate-x-0 lg:shadow-none ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
			>
				<div
					class="flex h-full min-h-0 flex-col transition-opacity duration-150"
					class:opacity-0={!pageVisible}
				>
					<div class="flex flex-1 flex-col space-y-6 px-2 pt-4">
						<div class="flex min-w-0 items-center justify-between gap-2 px-2 text-neutral-700">
							<div class="flex min-w-0 flex-1 items-center gap-2">
								<div class="h-4.5 w-4.5 shrink-0 rounded-sm bg-neutral-700"></div>
								<span class="min-w-0 flex-1 truncate text-sm text-neutral-700">
									{data?.workspace?.name ?? ''}
								</span>
							</div>
							<a
								href={`${basePath}/search`}
								class="shrink-0 rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
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
							{#each navItems.filter((item) => item.id !== 'people' || canViewPeople) as item}
								<a
									href={`${basePath}/${item.href}`}
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-normal transition ${currentPath === `${basePath}/${item.href}` || currentPath.startsWith(`${basePath}/${item.href}/`) ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
								>
									<span class="truncate">{item.label}</span>
								</a>
							{/each}
							{#if canViewProperties}
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
												<div class="px-2 py-1.5 text-xs text-neutral-400">
													Loading properties...
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
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
