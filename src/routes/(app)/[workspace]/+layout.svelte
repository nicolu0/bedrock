<script>
	// @ts-nocheck
	import { onMount, onDestroy, setContext, tick } from 'svelte';
	import { fade, scale, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { get } from 'svelte/store';
	import { page, navigating } from '$app/stores';
	import { browser } from '$app/environment';
	import { goto, invalidate, beforeNavigate, afterNavigate } from '$app/navigation';
	import { issuesCache, ensureIssuesCache } from '$lib/stores/issuesCache';
	import { propertiesCache } from '$lib/stores/propertiesCache';
	import { notificationsCache, ensureNotificationsCache } from '$lib/stores/notificationsCache';
	import { ensurePoliciesCache } from '$lib/stores/policiesCache';
	import { peopleMembersCache, ensurePeopleMembersCache } from '$lib/stores/peopleMembersCache';
	import { ensurePeopleCache, peopleCache } from '$lib/stores/peopleCache.js';
	import { pageReady } from '$lib/stores/pageReady';
	import { agentToasts } from '$lib/stores/agentToasts';
	import {
		rightPanel,
		openChatPanel,
		openChatPanelIfPreferred,
		getChatPanelPreferredOpen,
		closePanel,
		closePanelPersistingChatPreference,
		toggleChatPanel
	} from '$lib/stores/rightPanel.js';
	import { encodePathSegment } from '$lib/utils/url.js';
	import { supabase } from '$lib/supabaseClient.js';
	import AgentToasts from '$lib/components/AgentToasts.svelte';
	import ChatPanel from '$lib/components/ChatPanel.svelte';
	import IssuePanel from '$lib/components/IssuePanel.svelte';
	export let data;

	let appMounted = false;
	let isMobileViewport = false;
	let chatRevealTimer = null;
	let chatRevealTriggered = false;

	// Navigation loading bar
	let _navProgress = 0;
	let _navVisible = false;
	let _navHideTimer;
	let _navShowTimer;
	let _navCreepTimer;
	let _pendingFetches = 0;
	let _completedFetches = 0;
	let _navActive = false;
	let _navLocked = false;
	let _navGeneration = 0;
	let _origFetch;

	function _updateNavProgress() {
		if (_pendingFetches === 0) return;
		_navProgress = 10 + (_completedFetches / _pendingFetches) * 82;
	}

	function _startCreep() {
		_stopCreep();
		const tick = () => {
			const cap = 85;
			if (_navProgress < cap) {
				// Random nudge between 3% and 8%
				const nudge = 3 + Math.random() * 5;
				_navProgress = Math.min(_navProgress + nudge, cap);
			}
			// Random delay between 600ms and 1200ms
			const delay = 600 + Math.random() * 600;
			_navCreepTimer = setTimeout(tick, delay);
		};
		const initialDelay = 600 + Math.random() * 600;
		_navCreepTimer = setTimeout(tick, initialDelay);
	}

	function _stopCreep() {
		clearTimeout(_navCreepTimer);
		_navCreepTimer = null;
	}

	beforeNavigate(() => {
		if (_navLocked) return;
		clearTimeout(_navShowTimer);
		_stopCreep();
		_navActive = true;
		_navGeneration++;
		_pendingFetches = 0;
		_completedFetches = 0;
		if (_navVisible) {
			// Bar is already showing — reset to start to signal a new navigation
			_navProgress = 10;
			_startCreep();
		} else {
			_navProgress = 10;
			// Only show bar if navigation takes longer than 100ms
			_navShowTimer = setTimeout(() => {
				_navShowTimer = null;
				_navVisible = true;
				_startCreep();
			}, 100);
		}
	});

	afterNavigate(() => {
		if (_navLocked) return;
		_navActive = false;
		_stopCreep();
		// If the show timer hasn't fired yet, navigation was instant — suppress the bar
		if (_navShowTimer) {
			clearTimeout(_navShowTimer);
			_navShowTimer = null;
			_navProgress = 0;
			return;
		}
		_navLocked = true;
		_navProgress = 100;
		_navHideTimer = setTimeout(() => {
			_navVisible = false;
			setTimeout(() => {
				_navProgress = 0;
				_navLocked = false;
			}, 150);
		}, 200);
	});
	let showSearchModal = false;
	let searchInput;
	let searchQuery = '';
	let recentIssues = [];
	let recentIssueResults = [];
	let displayedResults = [];
	let showSearchResultsPanel = false;
	let issueByReadableId = new Map();
	let _recentIssuesWorkspace = null;
	let _lastRecordedRecentIssuePath = null;
	const RECENT_ISSUES_LIMIT = 8;
	const getRecentIssuesStorageKey = (slug) => `recentIssues:${slug}`;
	const loadRecentIssues = (slug) => {
		if (!browser || !slug) return [];
		try {
			const raw = localStorage.getItem(getRecentIssuesStorageKey(slug));
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			// Back-compat: allow older string-only lists.
			return parsed
				.map((entry) => (typeof entry === 'string' ? { readableId: entry, visitedAt: 0 } : entry))
				.filter((entry) => entry?.readableId)
				.sort((a, b) => (b?.visitedAt ?? 0) - (a?.visitedAt ?? 0))
				.slice(0, RECENT_ISSUES_LIMIT);
		} catch {
			return [];
		}
	};
	const saveRecentIssues = (slug, list) => {
		if (!browser || !slug) return;
		try {
			localStorage.setItem(getRecentIssuesStorageKey(slug), JSON.stringify(list));
		} catch {
			// Ignore storage quota / privacy mode.
		}
	};
	const upsertRecentIssue = (readableId) => {
		if (!browser || !workspaceSlug || !readableId) return;
		const now = Date.now();
		const next = [
			{ readableId, visitedAt: now },
			...recentIssues.filter((entry) => entry?.readableId && entry.readableId !== readableId)
		].slice(0, RECENT_ISSUES_LIMIT);
		recentIssues = next;
		saveRecentIssues(workspaceSlug, next);
	};
	const getIssueReadableIdFromPathname = (pathname) => {
		const parts = (pathname ?? '').split('/').filter(Boolean);
		const idx = parts.indexOf('issue');
		if (idx === -1) return null;
		const raw = parts[idx + 1] ?? null;
		if (!raw) return null;
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	};
	const isEditableTarget = (target) => {
		if (!target) return false;
		if (target.isContentEditable) return true;
		const tagName = target.tagName?.toLowerCase?.();
		return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
	};
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
		return `${basePath}/issue/${encodePathSegment(readableId)}/${slug}`;
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
		if (window.innerWidth < 1024) {
			sidebarOpen = false;
		}

		const mobileQuery = window.matchMedia('(max-width: 639px)');
		const updateMobileViewport = () => {
			isMobileViewport = mobileQuery.matches;
			const panelState = get(rightPanel);
			if (isMobileViewport && panelState?.open && panelState?.type === 'chat') {
				closePanel();
			}
			if (
				!isMobileViewport &&
				chatRevealTriggered &&
				!panelState?.open &&
				panelState?.type === 'chat'
			) {
				openChatPanelIfPreferred();
			}
		};
		updateMobileViewport();
		if (!isMobileViewport && !chatRevealTriggered) {
			chatRevealTriggered = true;
			chatRevealTimer = setTimeout(() => {
				const panelState = get(rightPanel);
				if (!panelState?.open && panelState?.type === 'chat') {
					openChatPanelIfPreferred();
				}
			}, 260);
		}
		if (mobileQuery.addEventListener) {
			mobileQuery.addEventListener('change', updateMobileViewport);
		} else {
			mobileQuery.addListener(updateMobileViewport);
		}

		_origFetch = window.fetch;
		window.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			const isDataReq = url.includes('__data.json');
			const gen = _navGeneration;
			if (_navActive && isDataReq) {
				_pendingFetches++;
				_updateNavProgress();
			}
			try {
				const res = await _origFetch(input, init);
				if (_navActive && isDataReq && gen === _navGeneration) {
					_completedFetches++;
					_updateNavProgress();
				}
				return res;
			} catch (e) {
				if (_navActive && isDataReq && gen === _navGeneration) {
					_completedFetches++;
					_updateNavProgress();
				}
				throw e;
			}
		};

		const onKeydown = (event) => {
			if (isEditableTarget(event.target)) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				if (showSearchModal) {
					closeSearchModal();
				} else {
					openSearchModal();
				}
				return;
			}
			if (event.key === '[') {
				event.preventDefault();
				sidebarOpen = !sidebarOpen;
				return;
			}
			if (event.key === ']') {
				event.preventDefault();
				if (!isMobileViewport) {
					toggleChatPanel();
				}
				return;
			}
			if (event.key === 'Escape' && showSearchModal) {
				closeSearchModal();
			}
		};
		window.addEventListener('keydown', onKeydown);
		return () => {
			if (chatRevealTimer) {
				clearTimeout(chatRevealTimer);
				chatRevealTimer = null;
			}
			window.removeEventListener('keydown', onKeydown);
			if (mobileQuery.removeEventListener) {
				mobileQuery.removeEventListener('change', updateMobileViewport);
			} else {
				mobileQuery.removeListener(updateMobileViewport);
			}
		};
	});

	$: normalizedSearchQuery = searchQuery.trim().toLowerCase();
	$: if (!showSearchModal && searchQuery) searchQuery = '';
	$: if (browser && workspaceSlug && _recentIssuesWorkspace !== workspaceSlug) {
		_recentIssuesWorkspace = workspaceSlug;
		_lastRecordedRecentIssuePath = null;
		recentIssues = loadRecentIssues(workspaceSlug);
	}
	$: issuesList = $issuesCache.data?.issues ?? [];
	$: issueSections = $issuesCache.data?.sections ?? [];
	$: sectionIssues = issueSections.flatMap((section) => section?.items ?? []);
	$: sectionSubIssues = sectionIssues.flatMap((item) => item?.subIssues ?? []);
	$: combinedIssues = [...issuesList, ...sectionIssues, ...sectionSubIssues];
	$: issueByReadableId = (() => {
		const map = new Map();
		for (const issue of combinedIssues) {
			const readableId = getIssueReadableId(issue);
			if (!readableId || map.has(readableId)) continue;
			map.set(readableId, issue);
		}
		return map;
	})();
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
	$: recentIssueResults = (() => {
		if (!browser || !recentIssues.length) return [];
		const results = [];
		for (const entry of recentIssues) {
			const readableId = entry?.readableId;
			if (!readableId) continue;
			const issue = issueByReadableId.get(readableId) ?? null;
			const issueLike = issue ?? { readable_id: readableId, title: readableId };
			const href = getIssueHref(issueLike);
			if (!href) continue;
			results.push({
				id: readableId,
				type: 'issue',
				title: getIssueTitle(issueLike),
				right: readableId,
				status: issue?.status,
				href
			});
		}
		return results;
	})();
	$: showSearchResultsPanel = Boolean(normalizedSearchQuery) || recentIssueResults.length > 0;
	$: displayedResults = normalizedSearchQuery ? searchResults : recentIssueResults;
	$: if (browser && workspaceSlug) {
		const readableId = getIssueReadableIdFromPathname(currentPath);
		if (readableId && currentPath && currentPath !== _lastRecordedRecentIssuePath) {
			_lastRecordedRecentIssuePath = currentPath;
			upsertRecentIssue(readableId);
		}
	}
	$: pageVisible = appMounted && $pageReady;
	$: workspaceSlug = $page.params.workspace;
	$: _inboxNotifications =
		$notificationsCache?.workspace === workspaceSlug && $notificationsCache?.data?.notifications
			? $notificationsCache.data.notifications
			: [];
	$: inboxCount = _inboxNotifications.filter((n) => !n.is_read && !n.is_resolved).length;
	$: inboxCountLabel = String(inboxCount);
	$: inboxCountCompact = inboxCountLabel.length === 1;
	$: isIssueRoute = $page.url.pathname.includes('/issue/');
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: isSettingsRoute = $page.url.pathname.startsWith(`${basePath}/settings`);
	$: isInboxRoute = $page.url.pathname.startsWith(`${basePath}/inbox`);
	$: currentPath = $page.url.pathname;
	$: _activePath = $navigating?.to?.url?.pathname ?? currentPath;
	$: activeItem = [...navItems, propertiesItem, settingsItem].find(
		(item) =>
			_activePath === `${basePath}/${item.href}` ||
			_activePath.startsWith(`${basePath}/${item.href}/`)
	);

	// Resolve streaming properties promise for sidebar
	let _resolvedProperties = null;
	$: {
		const propData = data.properties;
		if (propData instanceof Promise) {
			propData.then((list) => {
				if (Array.isArray(list)) {
					_resolvedProperties = list;
					propertiesCache.set(list);
				}
			});
		} else if (Array.isArray(propData)) {
			_resolvedProperties = propData;
			propertiesCache.set(propData);
		}
	}
	$: properties = $propertiesCache ?? _resolvedProperties;

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
		{ id: 'policies', label: 'Policies', href: 'policies' },
		{ id: 'people', label: 'People', href: 'people' }
	];
	const propertiesItem = { id: 'properties', label: 'Properties', href: 'properties' };
	const settingsItem = { id: 'settings', label: 'Settings', href: 'settings' };
	let propertiesOpen = true;
	let sidebarOpen = browser ? window.innerWidth >= 1024 : false;
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
	$: canViewPeople = userRole === 'admin' || userRole === 'bedrock' || userRole === 'member';
	$: canViewProperties =
		userRole === 'admin' || userRole === 'bedrock' || userRole === 'member' || userRole === 'owner';

	$: if (browser && workspaceSlug) {
		ensureIssuesCache(workspaceSlug);
		ensureNotificationsCache(workspaceSlug);
		ensurePoliciesCache(workspaceSlug);
		if (canViewPeople) {
			ensurePeopleMembersCache(workspaceSlug);
			ensurePeopleCache(workspaceSlug);
		}
	}

	$: if (!isInboxRoute && $rightPanel?.type === 'issue' && !isMobileViewport) {
		// Issue panel is only meant for inbox; elsewhere either show chat (if preferred) or close.
		if (getChatPanelPreferredOpen()) openChatPanel();
		else closePanel();
	}
	$: if (isMobileViewport && $rightPanel?.open && $rightPanel?.type === 'chat') {
		closePanel();
	}

	let _workspaceChannel = null;
	let _issuesChannel = null;
	let _agentEventsChannel = null;
	let _sessionReady = false;
	let _workspaceChannelWorkspaceId = null;
	let _authSubscription = null;
	const handleAgentEvent = (payload) => {
		const record = payload?.new ?? null;
		if (!record?.run_id) return;
		agentToasts.upsert(record);
		_rtNotifsV++;
	};

	// RT → Svelte bridge: counters force a Svelte flush so invalidate() runs inside the update cycle
	let _rtIssuesV = 0,
		_doneIssuesV = 0;
	let _rtNotifsV = 0,
		_doneNotifsV = 0;
	let _rtPoliciesV = 0,
		_donePoliciesV = 0;
	let _rtActivityV = 0,
		_doneActivityV = 0;
	let _rtLogsV = 0,
		_doneLogsV = 0;

	$: if (_rtIssuesV > _doneIssuesV) {
		console.log('[RT] invalidating issues, v:', _rtIssuesV);
		_doneIssuesV = _rtIssuesV;
		if (!isIssueRoute) invalidate('app:issues');
		if (browser) ensureIssuesCache(workspaceSlug, { force: true });
	}
	$: if (_rtNotifsV > _doneNotifsV) {
		console.log('[RT] invalidating notifications, v:', _rtNotifsV);
		_doneNotifsV = _rtNotifsV;
		invalidate('app:notifications');
		if (browser) ensureNotificationsCache(workspaceSlug, { force: true });
	}
	$: if (_rtPoliciesV > _donePoliciesV) {
		console.log('[RT] invalidating policies, v:', _rtPoliciesV);
		_donePoliciesV = _rtPoliciesV;
		invalidate('app:policies');
		if (browser) ensurePoliciesCache(workspaceSlug, { force: true });
	}
	$: if (_rtActivityV > _doneActivityV) {
		_doneActivityV = _rtActivityV;
		if (!isIssueRoute) invalidate('app:activity');
	}
	$: if (_rtLogsV > _doneLogsV) {
		_doneLogsV = _rtLogsV;
		if (!isIssueRoute) invalidate('app:activityLogs');
	}

	onMount(async () => {
		// Ensure the browser Supabase client has the authenticated session from the server.
		// createBrowserClient reads from cookies, but the access token may have expired —
		// the server always has a fresh token via hooks.server.js, so we pass it explicitly.
		if (data.session) {
			await supabase.auth.setSession(data.session);
			if (data.session.access_token) {
				supabase.realtime.setAuth(data.session.access_token);
			}
		}
		_sessionReady = true;

		const { data: authData } = supabase.auth.onAuthStateChange((_event, session) => {
			if (session?.access_token) {
				supabase.realtime.setAuth(session.access_token);
				if (workspaceId && userId) {
					setupWorkspaceChannel(workspaceId, userId);
				}
			}
		});
		_authSubscription = authData?.subscription ?? null;
	});

	const setupWorkspaceChannel = (wid, uid) => {
		if (!wid || !uid) return;
		if (_workspaceChannel && _workspaceChannelWorkspaceId === wid) return;
		if (_workspaceChannel) {
			supabase.removeChannel(_workspaceChannel);
			_workspaceChannel = null;
			_workspaceChannelWorkspaceId = null;
		}
		if (_issuesChannel) {
			supabase.removeChannel(_issuesChannel);
			_issuesChannel = null;
		}
		if (_agentEventsChannel) {
			supabase.removeChannel(_agentEventsChannel);
			_agentEventsChannel = null;
		}

		_workspaceChannel = supabase
			.channel(`workspace-delta-${wid}`)
			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
				() => {
					console.log('[RT] notifications event');
					_rtNotifsV++;
				}
			)

			.on(
				'postgres_changes',
				{
					event: '*',
					schema: 'public',
					table: 'workspace_policies',
					filter: `workspace_id=eq.${wid}`
				},
				() => {
					console.log('[RT] policies event');
					_rtPoliciesV++;
				}
			)

			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'messages', filter: `workspace_id=eq.${wid}` },
				() => {
					_rtActivityV++;
				}
			)

			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'drafts', filter: `workspace_id=eq.${wid}` },
				(payload) => {
					if (payload?.eventType === 'UPDATE') return;
					_rtActivityV++;
					_rtNotifsV++;
				}
			)

			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'activity_logs', filter: `workspace_id=eq.${wid}` },
				() => {
					_rtLogsV++;
				}
			)

			.subscribe((status) => {
				console.log('[RT] channel status:', status);
				if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
					_rtIssuesV++;
					_rtNotifsV++;
					_rtPoliciesV++;
					_rtActivityV++;
					_rtLogsV++;
					invalidate('app:people');
					invalidate('app:properties');
					invalidate('app:policies');
				}
			});
		_workspaceChannelWorkspaceId = wid;

		_issuesChannel = supabase
			.channel(`issues-${wid}`)
			.on('postgres_changes', { event: '*', schema: 'public', table: 'issues' }, (payload) => {
				const record = payload?.new ?? payload?.old ?? null;
				if (record?.workspace_id && record.workspace_id !== wid) return;
				console.log('[RT] issues event', payload?.eventType, record?.id);
				_rtIssuesV++;
			})
			.subscribe((status) => {
				console.log('[RT] issues channel status:', status);
			});

		_agentEventsChannel = supabase
			.channel(`agent-events-${wid}`)
			.on(
				'postgres_changes',
				{
					event: '*',
					schema: 'public',
					table: 'agent_events',
					filter: `workspace_id=eq.${wid}`
				},
				(payload) => {
					console.log('[RT] agent event', payload?.new);
					handleAgentEvent(payload);
				}
			)
			.subscribe((status) => {
				console.log('[RT] agent channel status:', status);
			});
	};

	$: if (browser && _sessionReady && workspaceId && userId) {
		setupWorkspaceChannel(workspaceId, userId);
	}

	onDestroy(() => {
		if (_workspaceChannel) supabase.removeChannel(_workspaceChannel);
		if (_issuesChannel) supabase.removeChannel(_issuesChannel);
		if (_agentEventsChannel) supabase.removeChannel(_agentEventsChannel);
		_authSubscription?.unsubscribe?.();
		if (_origFetch) window.fetch = _origFetch;
	});
</script>

<div
	class="pointer-events-none fixed top-0 left-0 z-[9999] h-[2px] bg-blue-500"
	style="width: {_navProgress}%; opacity: {_navVisible ? 1 : 0};
         transition: width 180ms ease-out, opacity 150ms ease;"
></div>

<AgentToasts />

{#if isSettingsRoute}
	<slot />
{:else}
	<div class="h-screen bg-white text-neutral-900">
		<div class="flex h-screen flex-row">
			<div
				class={`fixed inset-0 z-40 bg-neutral-900/40 transition-opacity duration-200 ease-out lg:hidden ${sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
				on:click={() => (sidebarOpen = false)}
			></div>
			<aside
				class={`fixed inset-y-0 left-0 z-50 h-screen overflow-hidden border-r border-neutral-200 bg-neutral-50/95 shadow-xl transition-[transform,width] duration-100 ease-out lg:static lg:z-auto lg:flex-none lg:shadow-none ${sidebarOpen ? 'w-72 translate-x-0 lg:w-60 lg:translate-x-0' : 'w-72 -translate-x-full lg:w-0 lg:translate-x-0 lg:border-r-0'}`}
			>
				<div
					class="flex h-full min-h-0 flex-col transition-opacity duration-150"
					class:opacity-0={!pageVisible}
				>
					<div class="flex flex-1 flex-col space-y-6 overflow-y-auto px-2 pt-4">
						<div class="flex min-w-0 items-center justify-between gap-2 px-2 text-neutral-700">
							<div class="flex min-w-0 flex-1 items-center gap-2">
								<div
									class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] bg-neutral-700 text-[8px] font-medium text-white"
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
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition ${currentPath === `${basePath}/${item.href}` || currentPath.startsWith(`${basePath}/${item.href}/`) ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
								>
									<div class="flex min-w-0 flex-1 items-center gap-2">
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
										{:else if item.id === 'policies'}
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
										{:else if item.id === 'inbox'}
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="16"
												height="16"
												fill="currentColor"
												class="shrink-0 text-neutral-600"
												viewBox="0 0 16 16"
											>
												<path
													d="M4.98 4a.5.5 0 0 0-.39.188L1.54 8H6a.5.5 0 0 1 .5.5 1.5 1.5 0 1 0 3 0A.5.5 0 0 1 10 8h4.46l-3.05-3.812A.5.5 0 0 0 11.02 4zm-1.17-.437A1.5 1.5 0 0 1 4.98 3h6.04a1.5 1.5 0 0 1 1.17.563l3.7 4.625a.5.5 0 0 1 .106.374l-.39 3.124A1.5 1.5 0 0 1 14.117 13H1.883a1.5 1.5 0 0 1-1.489-1.314l-.39-3.124a.5.5 0 0 1 .106-.374z"
												/>
											</svg>
										{/if}
										<span class="truncate">{item.label}</span>
									</div>
									{#if item.id === 'inbox' && inboxCount > 0}
										<span class="ml-auto inline-flex min-w-[18px] items-center justify-center">
											<span
												class="inline-flex items-center justify-center rounded bg-neutral-200/70 px-2 py-1 text-[11px] leading-none font-medium whitespace-nowrap text-neutral-800"
											>
												<span class="inline-flex whitespace-nowrap">
													{#key inboxCount}
														<span
															in:fly={{ y: 6, duration: 160 }}
															class="inline-flex items-center justify-center"
														>
															{inboxCountLabel}
														</span>
													{/key}
												</span>
											</span>
										</span>
									{/if}
								</a>
							{/each}
							{#if isMobileViewport}
								<button
									type="button"
									on:click={() => goto(`${basePath}/${settingsItem.href}`)}
									class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition ${currentPath === `${basePath}/${settingsItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
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
							{/if}
							{#if canViewProperties}
								<div class="mt-2">
									<button
										type="button"
										class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] font-medium text-neutral-400 transition hover:bg-neutral-100"
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
												class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium transition ${currentPath === `${basePath}/${propertiesItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
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
															class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium transition ${currentPath.startsWith(`${basePath}/${propertiesItem.href}/${slugify(property.name)}`) ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
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
							{#if !isMobileViewport}
								<div class="mt-auto">
									<button
										type="button"
										on:click={() => goto(`${basePath}/${settingsItem.href}`)}
										class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition ${currentPath === `${basePath}/${settingsItem.href}` ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
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
							{/if}
						</div>
					</div>
				</div>
			</aside>
			<section class="min-w-0 flex-1 overflow-visible">
				<div class="flex h-full w-full min-w-0">
					<div
						class={`relative z-10 flex min-h-0 min-w-0 flex-none flex-col overflow-visible transition-[width] duration-[280ms] ease-out lg:z-50 ${
							$rightPanel.open
								? $rightPanel.type === 'issue'
									? 'w-1/2 border-r border-neutral-200'
									: 'w-2/3 border-r border-neutral-200'
								: 'w-full'
						}`}
					>
						<div class="h-full min-h-0 w-full">
							<slot />
						</div>
					</div>
					{#if $rightPanel.open && !(isMobileViewport && $rightPanel.type === 'chat')}
						<div
							class={`relative z-0 min-w-0 flex-none overflow-x-hidden overflow-y-auto ${
								$rightPanel.type === 'issue' ? 'w-1/2' : 'w-1/3'
							}`}
							in:fly={{ x: 400, duration: 280, easing: cubicOut }}
							out:fly={{ x: 400, duration: 220, easing: cubicOut }}
						>
							{#if $rightPanel.type === 'issue'}
								<IssuePanel
									issueId={$rightPanel.issueId}
									seedIssue={$rightPanel.seedIssue}
									activityData={$rightPanel.activityData}
									activityLogsData={$rightPanel.activityLogsData}
									vendors={$rightPanel.vendors}
									people={$rightPanel.people}
									allIssues={$rightPanel.allIssues}
									on:close={() => {
										closePanel();
										$rightPanel.onClose?.();
									}}
									on:resolved={() => $rightPanel.onResolved?.()}
								/>
							{:else}
								<ChatPanel on:close={() => closePanelPersistingChatPreference()} />
							{/if}
						</div>
					{/if}
				</div>
			</section>
			{#if showSearchModal}
				<div
					class="fixed inset-0 z-[200] bg-neutral-900/30"
					transition:fade={{ duration: 120 }}
					on:click={closeSearchModal}
					role="presentation"
				></div>
				<div
					class="pointer-events-none fixed inset-0 z-[210] flex items-start justify-center px-3 pt-24 sm:pt-28"
				>
					<div
						class="pointer-events-auto w-full max-w-xl rounded-xl border border-neutral-200 bg-white shadow-xl"
						transition:scale={{ duration: 140, start: 0.96 }}
						role="dialog"
						aria-modal="true"
						aria-labelledby="search-modal-title"
					>
						<div class="py-4">
							<div class="px-4">
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
							</div>

							{#if showSearchResultsPanel}
								<div class="mt-4 border-t border-neutral-100 pt-3">
									<div class="px-4">
										{#if !normalizedSearchQuery}
											<div class="px-2 pb-1 text-[11px] font-medium text-neutral-400">
												Recent issues
											</div>
										{/if}
										{#if displayedResults.length}
											<div class="space-y-1">
												{#each displayedResults as result}
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
										{:else if normalizedSearchQuery}
											<div class="px-2 py-2 text-sm text-neutral-400">No results found.</div>
										{/if}
									</div>
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
