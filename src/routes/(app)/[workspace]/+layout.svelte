<script>
	// @ts-nocheck
	import { onMount, onDestroy, setContext, tick } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { goto, invalidate } from '$app/navigation';
	import {
		issuesCache,
		ensureIssuesCache,
		applyIssueInsert,
		applyIssueDelete,
		updateIssueStatusInListCache,
		updateIssueFieldsInListCache
	} from '$lib/stores/issuesCache';
	import {
		notificationsCache,
		ensureNotificationsCache,
		addNotificationToCache,
		updateNotificationInCache,
		primeNotificationsCache
	} from '$lib/stores/notificationsCache';
	import {
		peopleMembersCache,
		primePeopleMembersCache,
		ensurePeopleMembersCache
	} from '$lib/stores/peopleMembersCache';
	import { ensurePeopleCache, peopleCache } from '$lib/stores/peopleCache.js';
	import {
		activityCache,
		ensureActivityCache,
		primeActivityCache,
		applyMessageDelta,
		applyDraftDelta,
		removeMessageFromCache,
		removeDraftFromCache
	} from '$lib/stores/activityCache';
	import {
		activityLogsCache,
		ensureActivityLogsCache,
		primeActivityLogsCache,
		applyActivityLogDelta,
		removeActivityLogFromCache
	} from '$lib/stores/activityLogsCache';
	import {
		updateIssueStatusInDetailCache,
		updateIssueFieldsInDetailCache,
		primeDetailCacheFromIssuesList
	} from '$lib/stores/issueDetailCache.js';
	import { pageReady } from '$lib/stores/pageReady';
	import { supabase } from '$lib/supabaseClient.js';
	export let data;

	let appMounted = false;
	let showSearchModal = false;
	let searchInput;
	let searchQuery = '';
	const openSearchModal = async () => {
		showSearchModal = true;
		await tick();
		searchInput?.focus();
	};
	const closeSearchModal = () => {
		showSearchModal = false;
	};
	const normalizeText = (value) => (value ?? '').toString().toLowerCase();
	const formatRole = (role) => {
		if (!role) return 'Member';
		return role[0].toUpperCase() + role.slice(1);
	};
	const normalizeIssueStatus = (value) => {
		if (!value) return 'todo';
		const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
		if (normalized === 'in_progress') return 'in_progress';
		if (normalized === 'done' || normalized === 'completed' || normalized === 'complete')
			return 'done';
		if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
		return normalized;
	};
	const issueStatusDotClass = (status) => {
		switch (normalizeIssueStatus(status)) {
			case 'in_progress':
				return 'bg-amber-500';
			case 'done':
				return 'bg-emerald-500';
			case 'todo':
			default:
				return 'bg-neutral-400';
		}
	};
	const getIssueReadableId = (issue) =>
		issue?.readableId ?? issue?.readable_id ?? issue?.issueNumber ?? issue?.issue_number ?? '';
	const getIssueTitle = (issue) => issue?.title ?? issue?.name ?? 'Untitled issue';
	const getIssueHref = (issue) => {
		const readableId = getIssueReadableId(issue);
		if (!readableId) return null;
		const slug = slugify(getIssueTitle(issue));
		return `${basePath}/issue/${readableId}/${slug}`;
	};
	const getPropertySlug = (property) => slugify(property?.name ?? 'property');
	const getUnitHref = (unit, property) => {
		if (!property) return null;
		const propertySlug = getPropertySlug(property);
		return `${basePath}/properties/${propertySlug}/units`;
	};
	const openSearchResult = (result) => {
		if (!result) return;
		if (result.type === 'person') {
			goto(`${basePath}/people?editPersonId=${result.id}`);
			closeSearchModal();
			return;
		}
		if (result.href) {
			goto(result.href);
		}
		closeSearchModal();
	};
	onMount(() => {
		appMounted = true;
		const onKeydown = (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				if (showSearchModal) {
					closeSearchModal();
				} else {
					openSearchModal();
				}
				return;
			}
			if (event.key === 'Escape' && showSearchModal) {
				closeSearchModal();
			}
		};
		window.addEventListener('keydown', onKeydown);
		return () => {
			window.removeEventListener('keydown', onKeydown);
		};
	});

	$: normalizedSearchQuery = searchQuery.trim().toLowerCase();
	$: if (!showSearchModal && searchQuery) searchQuery = '';
	$: issuesList = $issuesCache.data?.issues ?? [];
	$: issueSections = $issuesCache.data?.sections ?? [];
	$: sectionIssues = issueSections.flatMap((section) => section?.items ?? []);
	$: sectionSubIssues = sectionIssues.flatMap((item) => item?.subIssues ?? []);
	$: combinedIssues = [...issuesList, ...sectionIssues, ...sectionSubIssues];
	$: propertiesList = Array.isArray(_resolvedProperties) ? _resolvedProperties : [];
	$: unitsList = Array.isArray(_resolvedUnits) ? _resolvedUnits : [];
	$: peopleList =
		$peopleCache.workspace === workspaceSlug && Array.isArray($peopleCache.data)
			? $peopleCache.data
			: $peopleMembersCache.workspace === workspaceSlug && Array.isArray($peopleMembersCache.data)
				? $peopleMembersCache.data
				: [];
	$: propertyById = new Map((propertiesList ?? []).map((property) => [property?.id, property]));
	$: searchResults = (() => {
		if (!normalizedSearchQuery) return [];
		const results = [];
		const query = normalizedSearchQuery;
		const match = (value) => normalizeText(value).includes(query);
		const issueMatches = (() => {
			const seen = new Set();
			return combinedIssues
				.filter((issue) => {
					const readableId = getIssueReadableId(issue);
					if (!readableId) return false;
					if (
						!(
							match(getIssueTitle(issue)) ||
							(readableId && match(readableId)) ||
							match(issue?.property?.name) ||
							match(issue?.unit?.name)
						)
					)
						return false;
					if (seen.has(readableId)) return false;
					seen.add(readableId);
					return true;
				})
				.map((issue) => ({
					id: issue?.id ?? issue?.issueId ?? getIssueReadableId(issue),
					type: 'issue',
					title: getIssueTitle(issue),
					right: getIssueReadableId(issue),
					status: issue?.status,
					href: getIssueHref(issue)
				}));
		})();
		const propertyMatches = propertiesList
			.filter((property) => match(property?.name))
			.map((property) => ({
				id: property?.id ?? property?.name,
				type: 'property',
				title: property?.name ?? 'Property',
				right: 'Property',
				href: `${basePath}/properties/${getPropertySlug(property)}`
			}));
		const unitMatches = unitsList
			.filter((unit) => {
				const property = propertyById.get(unit?.property_id);
				if (!property) return false;
				return match(unit?.name) || match(property?.name);
			})
			.map((unit) => {
				const property = propertyById.get(unit?.property_id);
				return {
					id: unit?.id ?? unit?.name,
					type: 'unit',
					title: unit?.name ?? 'Unit',
					right: property?.name ?? 'Unit',
					href: getUnitHref(unit, property)
				};
			});
		const peopleMatches = peopleList
			.filter((person) => match(person?.name) || match(person?.email) || match(person?.role))
			.map((person) => ({
				id: person?.id,
				type: 'person',
				title: person?.name ?? person?.email ?? 'Person',
				role: formatRole(person?.role),
				href: `${basePath}/people?editPersonId=${person?.id}`
			}));
		results.push(...issueMatches, ...propertyMatches, ...unitMatches, ...peopleMatches);
		return results.slice(0, 12);
	})();
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

	// Resolve streaming properties promise for sidebar
	let _resolvedProperties = null;
	$: {
		const propData = data.properties;
		if (propData instanceof Promise) {
			propData.then((list) => {
				if (Array.isArray(list)) _resolvedProperties = list;
			});
		} else if (Array.isArray(propData)) {
			_resolvedProperties = propData;
		}
	}
	$: properties = _resolvedProperties;

	// Resolve streaming units promise for search
	let _resolvedUnits = null;
	$: {
		const unitsData = data.units;
		if (unitsData instanceof Promise) {
			unitsData.then((list) => {
				if (Array.isArray(list)) _resolvedUnits = list;
			});
		} else if (Array.isArray(unitsData)) {
			_resolvedUnits = unitsData;
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
		ensureIssuesCache(workspaceSlug);
		ensureNotificationsCache(workspaceSlug);
		if (canViewPeople) {
			ensurePeopleMembersCache(workspaceSlug);
			ensurePeopleCache(workspaceSlug);
		}
		ensureActivityCache(workspaceSlug);
		ensureActivityLogsCache(workspaceSlug);
	}

	let _workspaceChannel = null;

	// RT → Svelte bridge: counters force a Svelte flush so invalidate() runs inside the update cycle
	let _rtIssuesV = 0, _doneIssuesV = 0;
	let _rtNotifsV = 0, _doneNotifsV = 0;
	let _rtActivityV = 0, _doneActivityV = 0;
	let _rtLogsV = 0, _doneLogsV = 0;

	$: if (_rtIssuesV > _doneIssuesV) { _doneIssuesV = _rtIssuesV; invalidate('app:issues'); }
	$: if (_rtNotifsV > _doneNotifsV) { _doneNotifsV = _rtNotifsV; invalidate('app:notifications'); }
	$: if (_rtActivityV > _doneActivityV) { _doneActivityV = _rtActivityV; invalidate('app:activity'); }
	$: if (_rtLogsV > _doneLogsV) { _doneLogsV = _rtLogsV; invalidate('app:activityLogs'); }

	onMount(async () => {
		// Ensure the browser Supabase client has the authenticated session from the server.
		// createBrowserClient reads from cookies, but the access token may have expired —
		// the server always has a fresh token via hooks.server.js, so we pass it explicitly.
		if (data.session) {
			await supabase.auth.setSession(data.session);
		}

		const wid = workspaceId;
		const uid = userId;
		if (!wid) return;


		_workspaceChannel = supabase
			.channel(`workspace-delta-${wid}`)

			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'issues', filter: `workspace_id=eq.${wid}` },
				() => {
					_rtIssuesV++;
				}
			)

			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
				() => { _rtNotifsV++; }
			)

			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'messages', filter: `workspace_id=eq.${wid}` },
				() => { _rtActivityV++; }
			)

			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'email_drafts', filter: `workspace_id=eq.${wid}` },
				() => { _rtActivityV++; }
			)

			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'activity_logs', filter: `workspace_id=eq.${wid}` },
				() => { _rtLogsV++; }
			)

			.subscribe((status) => {
				if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
					_rtIssuesV++; _rtNotifsV++; _rtActivityV++; _rtLogsV++;
					invalidate('app:people');
					invalidate('app:properties');
				}
			});
	});

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
								<div
									class="flex h-3 w-3 shrink-0 items-center justify-center rounded-[2px] bg-neutral-700 text-[7px] font-medium text-white"
								>
									A
								</div>
								<span class="min-w-0 flex-1 truncate text-xs text-neutral-700">
									{data?.workspace?.name ?? ''}
								</span>
							</div>
							<button
								type="button"
								on:click={openSearchModal}
								class="shrink-0 rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
								aria-label="Open search"
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
							</button>
						</div>
						<div class="flex flex-1 flex-col gap-0.5 pb-4">
							{#each navItems.filter((item) => item.id !== 'people' || canViewPeople) as item}
								<a
									href={`${basePath}/${item.href}`}
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-normal transition ${currentPath === `${basePath}/${item.href}` || currentPath.startsWith(`${basePath}/${item.href}/`) ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
								>
									{#if item.id === 'people'}
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="12"
											height="12"
											fill="currentColor"
											class="shrink-0 text-neutral-600"
											viewBox="0 0 16 16"
										>
											<path
												d="M7 14s-1 0-1-1 1-4 5-4 5 3 5 4-1 1-1 1zm4-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6m-5.784 6A2.24 2.24 0 0 1 5 13c0-1.355.68-2.75 1.936-3.72A6.3 6.3 0 0 0 5 9c-4 0-5 3-5 4s1 1 1 1zM4.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5"
											/>
										</svg>
									{:else if item.id === 'my-issues'}
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="12"
											height="12"
											fill="currentColor"
											class="shrink-0 text-neutral-600"
											viewBox="0 0 16 16"
										>
											<path
												d="M2 2v13.5a.5.5 0 0 0 .74.439L8 13.069l5.26 2.87A.5.5 0 0 0 14 15.5V2a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2"
											/>
										</svg>
									{:else if item.id === 'inbox'}
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="12"
											height="12"
											fill="currentColor"
											class="shrink-0 text-neutral-600"
											viewBox="0 0 16 16"
										>
											<path
												d="M12.643 15C13.979 15 15 13.845 15 12.5V5H1v7.5C1 13.845 2.021 15 3.357 15zM5.5 7h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1M.8 1a.8.8 0 0 0-.8.8V3a.8.8 0 0 0 .8.8h14.4A.8.8 0 0 0 16 3V1.8a.8.8 0 0 0-.8-.8z"
											/>
										</svg>
									{/if}
									<span class="truncate">{item.label}</span>
								</a>
							{/each}
							{#if canViewProperties}
								<div class="mt-2">
									<button
										type="button"
										class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-neutral-400 transition hover:bg-neutral-100"
										on:click={() => (propertiesOpen = !propertiesOpen)}
									>
										<span class="truncate">{propertiesItem.label}</span>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="12"
											height="12"
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
												class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-normal transition ${currentPath === `${basePath}/${propertiesItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="12"
													height="12"
													fill="currentColor"
													class="text-neutral-600"
													viewBox="0 0 16 16"
												>
													<path
														d="M3 0a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V16h3a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1zm1 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5M4 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM7.5 5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM4.5 8h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5"
													/>
												</svg>
												<span>All properties</span>
											</a>
											{#if properties !== null}
												{#if properties?.length}
													{#each properties as property}
														<a
															href={`${basePath}/${propertiesItem.href}/${slugify(property.name)}`}
															class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-normal transition ${currentPath.startsWith(`${basePath}/${propertiesItem.href}/${slugify(property.name)}`) ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
														>
															<span class="h-1 w-1 rounded-full bg-neutral-700"></span>
															<span class="truncate">{property.name}</span>
														</a>
													{/each}
												{/if}
											{:else}
												<div class="px-2 py-1.5 text-[11px] text-neutral-400">
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
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${currentPath === `${basePath}/${settingsItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
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
				<div class="h-full w-full">
					<slot />
				</div>
			</section>
			{#if showSearchModal}
				<div
					class="fixed inset-0 z-40 bg-neutral-900/30"
					transition:fade={{ duration: 120 }}
					on:click={closeSearchModal}
					role="presentation"
				></div>
				<div
					class="pointer-events-none fixed inset-0 z-50 flex items-start justify-center px-4 pt-24 sm:pt-28"
				>
					<div
						class="pointer-events-auto w-full max-w-xl rounded-xl border border-neutral-200 bg-white shadow-xl"
						transition:scale={{ duration: 140, start: 0.96 }}
						role="dialog"
						aria-modal="true"
						aria-labelledby="search-modal-title"
					>
						<div class="px-3 py-4">
							<div class="flex w-full items-center">
								<input
									bind:this={searchInput}
									bind:value={searchQuery}
									class="w-full border-0 bg-transparent py-0 text-sm text-neutral-700 outline-none placeholder:text-neutral-400 focus:ring-0 focus:outline-none"
									placeholder="Ask Bedrock or search workspace"
									type="text"
									inputmode="search"
								/>
							</div>
							{#if normalizedSearchQuery}
								<div class="mt-4 pt-3">
									{#if searchResults.length}
										<div class="space-y-1">
											{#each searchResults as result}
												<button
													type="button"
													on:click={() => openSearchResult(result)}
													class="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-50"
												>
													<div class="flex min-w-0 items-center gap-2">
														{#if result.type === 'issue'}
															<span
																class={`h-2.5 w-2.5 shrink-0 rounded-full ${issueStatusDotClass(result.status)}`}
															></span>
														{:else if result.type === 'person'}
															<svg
																xmlns="http://www.w3.org/2000/svg"
																width="14"
																height="14"
																fill="currentColor"
																class="shrink-0 text-neutral-400"
																viewBox="0 0 16 16"
															>
																<path
																	d="M3 14s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1zm5-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6"
																/>
															</svg>
														{:else if result.type === 'property'}
															<svg
																xmlns="http://www.w3.org/2000/svg"
																width="14"
																height="14"
																fill="currentColor"
																class="shrink-0 text-neutral-400"
																viewBox="0 0 16 16"
															>
																<path
																	d="M3 0a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V16h3a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1zm1 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5M4 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM7.5 5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM4.5 8h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5"
																/>
															</svg>
														{:else}
															<span class="h-2.5 w-2.5 shrink-0 rounded-sm bg-neutral-300"></span>
														{/if}
														<div class="min-w-0">
															<div class="flex items-center gap-2">
																<span class="truncate">{result.title}</span>
																{#if result.type === 'person' && result.role}
																	<span class="text-xs text-neutral-400">{result.role}</span>
																{/if}
															</div>
														</div>
													</div>
													{#if result.type !== 'person' && result.right}
														<span class="text-xs text-neutral-400">{result.right}</span>
													{/if}
												</button>
											{/each}
										</div>
									{:else}
										<div class="px-2 py-2 text-sm text-neutral-400">No results found.</div>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
