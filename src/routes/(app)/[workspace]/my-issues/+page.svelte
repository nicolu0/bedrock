<script>
	// @ts-nocheck
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import { getContext } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import SidebarButton from '$lib/components/SidebarButton.svelte';
	import { toggleChatPanel } from '$lib/stores/rightPanel.js';
	import { seedIssueDetail } from '$lib/stores/issueDetailCache.js';
	import {
		applyIssueInsert,
		issuesCache,
		primeIssuesCache,
		updateIssueReadsInCache,
		updateIssueFieldsInListCache,
		updateIssueStatusInListCache
	} from '$lib/stores/issuesCache.js';
	import { supabase } from '$lib/supabaseClient.js';

	export let data;

	const tabs = ['All issues'];
	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();
	let showNewIssueModal = false;
	let newIssueTitle = '';
	let newIssueDescription = '';
	let newIssuePropertyId = '';
	let newIssueUnitId = '';
	let newIssueStatus = 'todo';
	let newIssueAssigneeId = '';
	let createIssueError = '';
	let creatingIssue = false;
	let filterOpen = false;
	let filterCategoryOpen = false;
	let filterValueOpen = false;
	let filterCategory = 'assignee';
	let filterValue = 'any';
	let showClosedIssues = true;
	let filteredSections = [];
	let dividerTooltipX = 0;
	let dividerTooltipY = 0;

	$: _resolvedIssues =
		$issuesCache?.workspace === $page.params.workspace && $issuesCache?.data
			? $issuesCache.data
			: null;
	$: {
		if (data.issuesData instanceof Promise) {
			const loadStartedAt = Date.now();
			data.issuesData.then((d) => {
				if (browser) primeIssuesCache($page.params.workspace, d, loadStartedAt);
				if (browser) {
					const mapped = d?.issueReadsById ?? {};
					updateIssueReadsInCache($page.params.workspace, currentUserId, mapped);
				}
			});
		} else if (data.issuesData) {
			if (browser) primeIssuesCache($page.params.workspace, data.issuesData);
			if (browser) {
				const mapped = data.issuesData?.issueReadsById ?? {};
				updateIssueReadsInCache($page.params.workspace, currentUserId, mapped);
			}
		}
	}

	$: if (browser && _resolvedIssues?.sections) {
		for (const section of _resolvedIssues.sections) {
			for (const item of section.items ?? []) {
				seedIssueDetail(item, item.subIssues ?? []);
			}
		}
	}

	$: sections = _resolvedIssues?.sections ?? [];
	const normalizeStatusKey = (value) => {
		if (!value) return 'todo';
		const normalized = value
			.toString()
			.toLowerCase()
			.trim()
			.replace(/\s+/g, '_')
			.replace(/-/g, '_');
		if (normalized === 'in_progress') return 'in_progress';
		if (normalized === 'done' || normalized === 'completed' || normalized === 'complete')
			return 'done';
		if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
		return normalized;
	};

	$: expandedSections = sections.map((section) => {
		const rows = section.items.flatMap((item) => {
			const subRows = (item.subIssues ?? []).map((subIssue) => {
				const assigneeId = subIssue.assigneeId ?? subIssue.assignee_id ?? null;
				const propertyId =
					subIssue.propertyId ??
					subIssue.property_id ??
					item.propertyId ??
					item.property_id ??
					null;
				return {
					...subIssue,
					issueId: subIssue.issueId ?? item.issueId,
					parentTitle: subIssue.parentTitle ?? item.title,
					assignees: subIssue.assignees ?? item.assignees ?? 0,
					assigneeId,
					assigneeBadge: getAssigneeBadge(assigneeId, membersByUserId),
					property: subIssue.property ?? item.property,
					propertyId,
					property_id: propertyId,
					unit: subIssue.unit ?? item.unit,
					status: normalizeStatusKey(subIssue.status ?? item.status ?? section.id),
					isSubIssue: true
				};
			});
			const assigneeId = item.assigneeId ?? item.assignee_id ?? null;
			const propertyId = item.propertyId ?? item.property_id ?? null;
			return [
				{
					...item,
					assigneeId,
					assigneeBadge: getAssigneeBadge(assigneeId, membersByUserId),
					propertyId,
					property_id: propertyId,
					status: normalizeStatusKey(item.status ?? section.id),
					isSubIssue: item.isSubIssue ?? false
				},
				...subRows
			];
		});
		return { ...section, rows };
	});

	$: workspaceSlug = $page.params.workspace;
	$: basePath = workspaceSlug ? `/${workspaceSlug}` : '';
	$: currentUserId = $page.data?.userId ?? '';
	$: role = ($page.data?.role ?? '').toString().toLowerCase();
	$: canEditIssue = role === 'admin' || role === 'bedrock';
	let _resolvedProperties = [];
	let _resolvedUnits = [];
	$: {
		const propsData = $page.data?.properties;
		if (propsData instanceof Promise) {
			propsData.then((list) => {
				_resolvedProperties = Array.isArray(list) ? list : [];
			});
		} else {
			_resolvedProperties = Array.isArray(propsData) ? propsData : [];
		}
	}
	$: {
		const unitsData = $page.data?.units;
		if (unitsData instanceof Promise) {
			unitsData.then((list) => {
				_resolvedUnits = Array.isArray(list) ? list : [];
			});
		} else {
			_resolvedUnits = Array.isArray(unitsData) ? unitsData : [];
		}
	}
	$: properties = _resolvedProperties;
	$: units = _resolvedUnits;
	$: propertiesById = properties.reduce((acc, property) => {
		if (!property?.id) return acc;
		acc[property.id] = property;
		return acc;
	}, {});
	$: unitsById = units.reduce((acc, unit) => {
		if (!unit?.id) return acc;
		acc[unit.id] = unit;
		return acc;
	}, {});
	$: availableUnits = newIssuePropertyId
		? units.filter((unit) => unit.property_id === newIssuePropertyId)
		: units;
	let _resolvedMembers = [];
	const getTimestamp = (value) => {
		if (!value) return 0;
		const ts = new Date(value).getTime();
		return Number.isFinite(ts) ? ts : 0;
	};
	$: {
		if (data.members instanceof Promise) {
			data.members.then((m) => {
				_resolvedMembers = m ?? [];
			});
		} else {
			_resolvedMembers = data.members ?? [];
		}
	}
	$: membersByUserId = _resolvedMembers.reduce((acc, member) => {
		if (!member?.user_id) return acc;
		acc[member.user_id] = member;
		return acc;
	}, {});
	$: members = _resolvedMembers;
	const statusOptions = [
		{ value: 'todo', label: 'Todo' },
		{ value: 'in_progress', label: 'In Progress' },
		{ value: 'done', label: 'Done' }
	];
	const statusClassByKey = {
		todo: 'border-neutral-500 text-neutral-700',
		in_progress: 'border-orange-500 text-orange-600',
		done: 'border-emerald-500 text-emerald-700'
	};
	const filterCategories = [
		{ value: 'assignee', label: 'Assignee' },
		{ value: 'status', label: 'Status' },
		{ value: 'building', label: 'Building' }
	];

	const hasUnseenUpdates = (item) => Boolean(item?.hasUnseenUpdates);

	const markIssueSeenFromList = async (item) => {
		if (!browser) return;
		const issueId = item?.id ?? item?.issueId ?? null;
		if (!issueId) return;
		const latest = getTimestamp(item?.updated_at ?? item?.updatedAt);
		const seenAt = new Date(Math.max(Date.now(), latest)).toISOString();
		if (browser) {
			updateIssueReadsInCache($page.params.workspace, currentUserId, { [issueId]: seenAt });
		}
		await fetch('/api/issue-reads/mark-seen', {
			method: 'POST',
			keepalive: true,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ issue_id: issueId })
		}).catch(() => {});
	};

	const handleIssueOpen = async (event, item) => {
		if (!event) return;
		if (event.defaultPrevented) return;
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		const href = getIssueHref(item);
		markIssueSeenFromList(item);
		if (href) goto(href);
	};

	const slugify = (value) => {
		if (!value) return 'issue';
		return value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)+/g, '');
	};

	const getIssueHref = (item) => {
		if (!item) return undefined;
		const slug = slugify(item.title);
		const readableId = item.readableId;
		if (!readableId) return undefined;
		return `${basePath}/issue/${readableId}/${slug}?from=my-issues`;
	};

	const avatarPalette = [
		'bg-amber-200',
		'bg-blue-200',
		'bg-emerald-200',
		'bg-rose-200',
		'bg-indigo-200',
		'bg-teal-200',
		'bg-orange-200',
		'bg-sky-200'
	];

	const getAvatarColor = (seed) => {
		if (!seed) return 'bg-neutral-200';
		const value = seed.toString();
		let hash = 0;
		for (let i = 0; i < value.length; i += 1) {
			hash = (hash * 31 + value.charCodeAt(i)) % avatarPalette.length;
		}
		return avatarPalette[hash] ?? 'bg-neutral-200';
	};

	const getAssigneeBadge = (assigneeId, membersMap) => {
		const member = assigneeId ? membersMap[assigneeId] : null;
		const name = member?.users?.name ?? member?.name ?? 'Assigned';
		const initial = (name ?? 'U').toString().trim().charAt(0).toUpperCase() || 'U';
		const color = getAvatarColor(assigneeId ?? name);
		if (!assigneeId) return null;
		return { name, initial, color };
	};

	const getUnitDisplay = (value) => {
		const normalized = (value ?? '').toString().trim();
		if (!normalized) return '-';
		const lowered = normalized.toLowerCase();
		if (lowered === 'unknown' || lowered === 'unknown unit') return '-';
		return normalized;
	};

	const getCreatedAgeLabel = (createdValue, lastActivityValue) => {
		if (!createdValue) return null;
		const createdAt = new Date(createdValue).getTime();
		if (!Number.isFinite(createdAt)) return null;
		if (lastActivityValue) {
			const lastActivityAt = new Date(lastActivityValue).getTime();
			if (Number.isFinite(lastActivityAt) && lastActivityAt > createdAt) return null;
		}
		const diffDays = Math.floor((Date.now() - createdAt) / (24 * 60 * 60 * 1000));
		if (diffDays < 2) return null;
		return `Created ${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
	};

	const getSectionGradientStyle = (statusClass) => {
		if (!statusClass) return '';
		if (statusClass.includes('orange')) {
			return 'background-image: linear-gradient(90deg, rgba(255, 237, 213, 0.16), rgba(255, 237, 213, 0.06), transparent);';
		}
		if (statusClass.includes('emerald')) {
			return 'background-image: linear-gradient(90deg, rgba(209, 250, 229, 0.14), rgba(209, 250, 229, 0.05), transparent);';
		}
		return '';
	};

	let filterValueOptions = [];
	let hoveredIssueId = null;
	$: {
		if (filterCategory === 'assignee') {
			const assigneeOptions = [...members]
				.filter((member) => {
					const role = (member?.role ?? '').toLowerCase();
					return (
						Boolean(member?.user_id) &&
						(role === 'admin' || role === 'bedrock' || role === 'member')
					);
				})
				.map((member) => ({
					value: member.user_id,
					label: member.users?.name ?? member.name ?? 'Member'
				}))
				.sort((a, b) => a.label.localeCompare(b.label));
			filterValueOptions = [
				{ value: 'any', label: 'Any assignee' },
				{ value: 'unassigned', label: 'Unassigned' },
				...assigneeOptions
			].filter((option) => option.value);
		} else if (filterCategory === 'status') {
			filterValueOptions = [{ value: 'any', label: 'Any status' }, ...statusOptions];
		} else if (filterCategory === 'building') {
			filterValueOptions = [
				{ value: 'any', label: 'Any building' },
				...properties.map((property) => ({
					value: property.id,
					label: property.name
				}))
			].filter((option) => option.value);
		} else {
			filterValueOptions = [{ value: 'any', label: 'Any' }];
		}
	}
	$: selectedCategory =
		filterCategories.find((option) => option.value === filterCategory) ?? filterCategories[0];
	$: {
		if (!filterValueOptions.some((option) => option.value === filterValue)) {
			filterValue = filterValueOptions[0]?.value ?? 'any';
		}
	}
	$: selectedValue =
		filterValueOptions.find((option) => option.value === filterValue) ?? filterValueOptions[0];

	const groupRowsByProperty = (rows) => {
		const groups = new Map();
		for (const row of rows ?? []) {
			const name = row?.property?.toString().trim() || 'Unknown property';
			if (!groups.has(name)) groups.set(name, []);
			groups.get(name).push(row);
		}
		return [...groups.entries()]
			.map(([name, items]) => ({ name, items }))
			.sort((a, b) => a.name.localeCompare(b.name));
	};

	let collapsedPropertyGroups = {};
	const getPropertyGroupKey = (sectionId, propertyName) =>
		`${sectionId ?? 'section'}::${propertyName ?? 'Unknown property'}`;
	const isPropertyGroupCollapsed = (sectionId, propertyName) =>
		Boolean(collapsedPropertyGroups[getPropertyGroupKey(sectionId, propertyName)]);
	const hasVisiblePropertyGroups = (section) =>
		(section?.propertyGroups ?? []).some(
			(group) => !isPropertyGroupCollapsed(section?.id, group?.name)
		);
	const togglePropertyGroup = (sectionId, propertyName) => {
		const key = getPropertyGroupKey(sectionId, propertyName);
		collapsedPropertyGroups = {
			...collapsedPropertyGroups,
			[key]: !collapsedPropertyGroups[key]
		};
	};

	const updateDividerTooltipPosition = (event) => {
		if (!event?.currentTarget) return;
		const tooltip = event.currentTarget.querySelector('[data-divider-tooltip="true"]');
		const rect = event.currentTarget.getBoundingClientRect();
		const viewportWidth = window?.innerWidth ?? document?.documentElement?.clientWidth ?? 0;
		const tooltipWidth = tooltip?.getBoundingClientRect?.().width ?? 0;
		const gutter = 12;
		let left = event.clientX + 8;
		left = Math.max(gutter, left);
		if (viewportWidth) {
			left = Math.min(left, viewportWidth - tooltipWidth - gutter);
		}
		dividerTooltipX = left;
		dividerTooltipY = rect.bottom - 6;
	};

	$: filteredSections = expandedSections
		.map((section) => {
			const rows = (section.rows ?? []).filter((row) => {
				if (!showClosedIssues && String(row.status ?? '') === 'done') return false;
				const parentId = row?.parentId ?? row?.parent_id ?? null;
				if (parentId) return false;
				if (filterCategory === 'assignee') {
					if (filterValue === 'any') return true;
					if (filterValue === 'unassigned') return !row.assigneeId;
					return String(row.assigneeId ?? '') === String(filterValue);
				}
				if (filterCategory === 'status') {
					if (filterValue === 'any') return true;
					return String(row.status ?? '') === String(filterValue);
				}
				if (filterCategory === 'building') {
					if (filterValue === 'any') return true;
					return String(row.propertyId ?? row.property_id ?? '') === String(filterValue);
				}
				return true;
			});
			return { ...section, rows, count: rows.length, propertyGroups: groupRowsByProperty(rows) };
		})
		.filter((section) => section.rows.length > 0);
	$: hasActiveFilter = filterValue !== 'any';

	const openNewIssueModal = () => {
		showNewIssueModal = true;
		createIssueError = '';
		if (!newIssueStatus) newIssueStatus = 'todo';
		if (!newIssueAssigneeId && currentUserId) newIssueAssigneeId = currentUserId;
		if (!newIssuePropertyId && properties.length === 1) {
			newIssuePropertyId = properties[0]?.id ?? '';
		}
		if (!newIssueUnitId && availableUnits.length === 1) {
			newIssueUnitId = availableUnits[0]?.id ?? '';
		}
	};

	const closeNewIssueModal = () => {
		showNewIssueModal = false;
		newIssueTitle = '';
		newIssueDescription = '';
		newIssuePropertyId = '';
		newIssueUnitId = '';
		newIssueStatus = 'todo';
		newIssueAssigneeId = '';
		createIssueError = '';
		document.activeElement?.blur();
	};

	const closeFilterMenus = () => {
		filterOpen = false;
		filterCategoryOpen = false;
		filterValueOpen = false;
	};

	const handleFilterCategorySelect = (next) => {
		filterCategory = next;
		filterValue = 'any';
		filterCategoryOpen = false;
		filterValueOpen = false;
	};

	const handleFilterValueSelect = (next) => {
		filterValue = next;
		filterValueOpen = false;
	};

	const onWindowClick = () => {
		if (filterOpen || filterCategoryOpen || filterValueOpen) closeFilterMenus();
		if (statusMenuOpenId || urgentMenuOpenId) {
			statusMenuOpenId = null;
			urgentMenuOpenId = null;
		}
	};

	const getRowIssueId = (item) => item?.id ?? item?.issueId ?? null;
	let statusMenuOpenId = null;
	let urgentMenuOpenId = null;
	let showUrgencyPolicyPrompt = false;
	let urgencyPolicyValue = 'not_urgent';
	let urgencyPolicyIssue = '';
	let urgencyPolicyMatchingId = null;
	let urgencyPolicyLoading = false;
	let urgencyPolicyError = '';

	const handleStatusSelect = async (item, nextStatus) => {
		if (!canEditIssue) return;
		const issueId = getRowIssueId(item);
		if (!issueId) return;
		const prevStatus = item?.status ?? 'todo';
		statusMenuOpenId = null;
		if (prevStatus === nextStatus) return;
		updateIssueStatusInListCache(issueId, nextStatus);
		const { error } = await supabase
			.from('issues')
			.update({ status: nextStatus })
			.eq('id', issueId);
		if (error) {
			updateIssueStatusInListCache(issueId, prevStatus);
		}
	};

	const handleUrgentSelect = async (item, nextUrgent) => {
		if (!canEditIssue) return;
		const issueId = getRowIssueId(item);
		const targetId = item?.isSubIssue ? (item?.parentId ?? item?.parent_id) : issueId;
		if (!targetId) return;
		const prevUrgent = item?.isSubIssue
			? (item?.root_urgent ?? item?.urgent ?? false)
			: (item?.urgent ?? false);
		urgentMenuOpenId = null;
		if (prevUrgent === nextUrgent) return;
		updateIssueFieldsInListCache(targetId, { urgent: nextUrgent });
		const { error } = await supabase
			.from('issues')
			.update({ urgent: nextUrgent })
			.eq('id', targetId);
		if (error) {
			updateIssueFieldsInListCache(targetId, { urgent: prevUrgent });
			return;
		}
		if (!item?.isSubIssue && !item?.parentId && !item?.parent_id) {
			openUrgencyPolicyPrompt(nextUrgent, item);
		}
	};

	const normalizePolicyLabel = (value) =>
		(value ?? '')
			.toString()
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.replace(/\s+/g, ' ');

	const openUrgencyPolicyPrompt = async (nextUrgent, item) => {
		urgencyPolicyValue = nextUrgent ? 'urgent' : 'not_urgent';
		urgencyPolicyIssue =
			item?.title?.toString().trim() || item?.name?.toString().trim() || 'Maintenance issue';
		urgencyPolicyMatchingId = null;
		urgencyPolicyError = '';
		showUrgencyPolicyPrompt = true;
		const workspaceId =
			$page.data?.workspace?.id ?? $page.data?.workspaceId ?? $page.data?.workspace_id ?? null;
		if (!workspaceId) return;
		urgencyPolicyLoading = true;
		try {
			const { data } = await supabase
				.from('workspace_policies')
				.select('id, meta, description')
				.eq('workspace_id', workspaceId)
				.eq('type', 'urgency')
				.order('updated_at', { ascending: false });
			const target = normalizePolicyLabel(urgencyPolicyIssue);
			const match = (data ?? []).find((row) => {
				const candidate = row?.meta?.maintenance_issue ?? row?.description ?? '';
				return normalizePolicyLabel(candidate) === target;
			});
			urgencyPolicyMatchingId = match?.id ?? null;
		} catch {
			urgencyPolicyError = 'Unable to load policies.';
		} finally {
			urgencyPolicyLoading = false;
		}
	};

	const closeUrgencyPolicyPrompt = () => {
		showUrgencyPolicyPrompt = false;
		urgencyPolicyError = '';
	};

	const saveUrgencyPolicy = async () => {
		if (!urgencyPolicyIssue.trim()) {
			urgencyPolicyError = 'Maintenance issue is required.';
			return;
		}
		urgencyPolicyLoading = true;
		urgencyPolicyError = '';
		try {
			const response = await fetch('/api/policies', {
				method: urgencyPolicyMatchingId ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: urgencyPolicyMatchingId,
					workspace: $page.params.workspace,
					type: 'urgency',
					urgency: urgencyPolicyValue,
					maintenance_issue: urgencyPolicyIssue.trim(),
					email: null,
					description: null
				})
			});
			const result = await response.json();
			if (!response.ok) {
				urgencyPolicyError = result?.error ?? 'Unable to save policy.';
				return;
			}
			closeUrgencyPolicyPrompt();
		} catch {
			urgencyPolicyError = 'Unable to save policy.';
		} finally {
			urgencyPolicyLoading = false;
		}
	};

	const handlePropertyChange = (event) => {
		newIssuePropertyId = event.target.value;
		if (!newIssuePropertyId) {
			newIssueUnitId = '';
			return;
		}
		const nextUnits = units.filter((unit) => unit.property_id === newIssuePropertyId);
		if (!nextUnits.some((unit) => unit.id === newIssueUnitId)) {
			newIssueUnitId = nextUnits[0]?.id ?? '';
		}
	};

	const handleCreateIssue = async () => {
		createIssueError = '';
		creatingIssue = true;
		try {
			const response = await fetch('/api/issues', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace: workspaceSlug,
					name: newIssueTitle.trim(),
					description: newIssueDescription.trim(),
					unitId: newIssueUnitId?.trim() ? newIssueUnitId.trim() : null,
					propertyId: newIssuePropertyId?.trim() ? newIssuePropertyId.trim() : null,
					status: newIssueStatus,
					assigneeId: newIssueAssigneeId?.trim() ? newIssueAssigneeId.trim() : null
				})
			});
			const result = await response.json();
			if (!response.ok) {
				createIssueError = result?.error ?? 'Unable to create issue.';
				return;
			}
			const selectedUnit = newIssueUnitId ? unitsById[newIssueUnitId] : null;
			const selectedProperty = selectedUnit
				? propertiesById[selectedUnit.property_id]
				: propertiesById[newIssuePropertyId];
			applyIssueInsert(result, {
				unitName: selectedUnit?.name ?? 'Unknown',
				propertyName: selectedProperty?.name ?? 'Unknown',
				parentTitle: ''
			});
			closeNewIssueModal();
		} catch {
			createIssueError = 'Unable to create issue.';
		} finally {
			creatingIssue = false;
		}
	};

	const onKeydown = (event) => {
		if (event.defaultPrevented) return;
		if (event.key === 'Escape' && showNewIssueModal) {
			closeNewIssueModal();
			return;
		}
		if (showNewIssueModal || showUrgencyPolicyPrompt) return;
		const target = event.target;
		const tagName = target?.tagName?.toLowerCase?.() ?? '';
		if (
			target?.isContentEditable ||
			tagName === 'input' ||
			tagName === 'textarea' ||
			tagName === 'select' ||
			tagName === 'button'
		) {
			return;
		}
	};
</script>

<svelte:window on:click={onWindowClick} on:keydown={onKeydown} />

<div class="flex h-full min-h-0 flex-col">
	<div class="flex items-center justify-between border-b border-neutral-200 py-2.5 pr-5 pl-6">
		<div class="flex items-center gap-2">
			<button
				type="button"
				aria-label="Open sidebar"
				class="rounded-md p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800 lg:hidden"
				on:click={openSidebar}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="12"
					height="12"
					fill="currentColor"
					class="bi bi-layout-sidebar"
					viewBox="0 0 16 16"
				>
					<path
						d="M0 3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm5-1v12h9a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zM4 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h2z"
					/>
				</svg>
			</button>
			<h1 class="text-sm font-normal text-neutral-700">My issues</h1>
		</div>
		<div class="flex items-center gap-2">
			<div class="hidden sm:flex">
				<SidebarButton onClick={toggleChatPanel} />
			</div>
		</div>
	</div>
	<div class="flex items-center justify-between border-b border-neutral-200 px-6 py-2">
		<div class="flex items-center gap-2">
			{#each tabs as tab}
				<button
					class={`rounded-md border px-2.5 py-1 text-xs transition ${
						tab === 'All issues'
							? 'border-neutral-200 bg-neutral-100 text-neutral-700'
							: 'border-neutral-200 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700'
					}`}
					type="button"
				>
					{tab}
				</button>
			{/each}
		</div>
		<div class="flex items-center gap-4 text-xs text-neutral-500">
			<div class="relative" on:click|stopPropagation>
				<button
					class="inline-flex items-center gap-2 hover:text-neutral-800"
					type="button"
					aria-expanded={filterOpen}
					on:click|stopPropagation={() => {
						filterOpen = !filterOpen;
						filterCategoryOpen = false;
						filterValueOpen = false;
					}}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						fill="currentColor"
						viewBox="0 0 16 16"
					>
						<path
							d="M6 10.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"
						/>
					</svg>
					Filter
				</button>
				{#if filterOpen}
					<div
						class="absolute right-0 z-20 mt-2 w-72 origin-top-right rounded-md border border-neutral-200 bg-white py-2 text-xs text-neutral-700 shadow-lg"
						on:click|stopPropagation
					>
						<div class="flex items-center gap-2 px-3 py-2">
							<div class="relative flex-1">
								<button
									type="button"
									class="flex w-full items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-left text-xs text-neutral-700 transition hover:bg-neutral-50"
									on:click|stopPropagation={() => {
										filterCategoryOpen = !filterCategoryOpen;
										filterValueOpen = false;
									}}
								>
									<span class="truncate">{selectedCategory?.label ?? 'Category'}</span>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="10"
										height="10"
										fill="currentColor"
										viewBox="0 0 16 16"
									>
										<path
											d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
										/>
									</svg>
								</button>
								{#if filterCategoryOpen}
									<div
										class="absolute left-0 z-30 mt-2 w-full rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
										on:click|stopPropagation
									>
										{#each filterCategories as option}
											<button
												type="button"
												class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
													filterCategory === option.value ? 'bg-neutral-50' : ''
												}`}
												on:click|stopPropagation={() => handleFilterCategorySelect(option.value)}
											>
												<span>{option.label}</span>
												{#if filterCategory === option.value}
													<span class="text-[10px] text-neutral-400">Selected</span>
												{/if}
											</button>
										{/each}
									</div>
								{/if}
							</div>
							<div class="relative flex-1">
								<button
									type="button"
									disabled={!filterValueOptions.length}
									class={`flex w-full items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-left text-xs text-neutral-700 transition hover:bg-neutral-50 ${
										filterValueOptions.length ? '' : 'cursor-not-allowed opacity-60'
									}`}
									on:click|stopPropagation={() => {
										if (!filterValueOptions.length) return;
										filterValueOpen = !filterValueOpen;
										filterCategoryOpen = false;
									}}
								>
									<span class="truncate">{selectedValue?.label ?? 'Value'}</span>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="12"
										height="12"
										fill="currentColor"
										viewBox="0 0 16 16"
									>
										<path
											d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
										/>
									</svg>
								</button>
								{#if filterValueOpen}
									{#key filterCategory}
										<div
											class="absolute left-0 z-30 mt-2 w-full rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
											on:click|stopPropagation
										>
											{#each filterValueOptions as option}
												<button
													type="button"
													class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
														filterValue === option.value ? 'bg-neutral-50' : ''
													}`}
													on:click={() => handleFilterValueSelect(option.value)}
												>
													<span>{option.label}</span>
													{#if filterValue === option.value}
														<span class="text-[10px] text-neutral-400">Selected</span>
													{/if}
												</button>
											{/each}
										</div>
									{/key}
								{/if}
							</div>
						</div>
						<div class="border-t border-neutral-200 px-3 py-2">
							<button
								type="button"
								class="flex w-full items-center justify-between gap-3 text-xs text-neutral-600"
								role="switch"
								aria-checked={showClosedIssues}
								on:click|stopPropagation={() => {
									showClosedIssues = !showClosedIssues;
								}}
							>
								<span>Show completed issues</span>
								<span
									class={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
										showClosedIssues ? 'bg-indigo-400' : 'bg-neutral-300'
									}`}
								>
									<span
										class={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
											showClosedIssues ? 'translate-x-4' : 'translate-x-1'
										}`}
									></span>
								</span>
							</button>
						</div>
					</div>
				{/if}

				<style>
					.tooltip-target .delayed-tooltip {
						opacity: 0;
						pointer-events: none;
					}

					.tooltip-target:hover .delayed-tooltip {
						opacity: 1;
					}

					.tooltip-target:focus-within .delayed-tooltip {
						opacity: 0;
					}

					.tooltip-target:focus-within:hover .delayed-tooltip {
						opacity: 1;
					}

					@media (hover: none) {
						.tooltip-target .delayed-tooltip {
							display: none;
						}
					}
				</style>
			</div>
		</div>
	</div>

	<div class="flex-1 overflow-y-auto" on:mouseleave={() => (hoveredIssueId = null)}>
		{#if _resolvedIssues === null}
			<div class="space-y-2 divide-y divide-neutral-100">
				{#each { length: 4 } as _}
					<div class="flex items-center gap-3 px-6 py-2">
						<div class="skeleton h-3 w-3 flex-shrink-0 rounded-full"></div>
						<div class="skeleton h-4 w-2/5"></div>
						<div class="skeleton ml-auto h-5 w-28 rounded-full"></div>
						<div class="skeleton h-5 w-5 rounded-full"></div>
					</div>
				{/each}
			</div>
		{:else if filteredSections.length === 0}
			<div class="px-6 py-8 text-sm text-neutral-400">
				{hasActiveFilter ? 'No issues match the current filter.' : 'No issues assigned to you.'}
			</div>
		{:else}
			<div>
				{#each filteredSections as section, sectionIndex}
					<div class={section.rows.length ? '' : 'hidden'}>
						<div
							class={`flex items-center justify-between border-neutral-200 bg-stone-50 px-6 py-2 text-sm text-neutral-600 ${
								sectionIndex === 0 ? 'border-b' : 'border-y'
							}`}
							style={getSectionGradientStyle(section.statusClass)}
						>
							<div class="flex items-center gap-3">
								<span class={`h-3.5 w-3.5 rounded-full border-[1.5px] ${section.statusClass}`}
								></span>
								<span class="text-sm text-neutral-700">{section.label}</span>
								<span class="text-sm text-neutral-400">{section.count}</span>
							</div>
							<div class="h-4 w-4"></div>
						</div>
						<div>
							{#each section.propertyGroups as group}
								{@const isCollapsed = isPropertyGroupCollapsed(section.id, group.name)}
								<button
									type="button"
									class="tooltip-target group relative flex w-full items-center gap-3 px-6.5 py-2.5 text-left text-xs text-neutral-400 transition hover:text-neutral-900"
									on:click={() => togglePropertyGroup(section.id, group.name)}
									on:mouseenter={updateDividerTooltipPosition}
									on:mousemove={updateDividerTooltipPosition}
									aria-expanded={!isCollapsed}
								>
									<span
										class="relative flex items-center text-neutral-400 transition group-hover:text-neutral-700"
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="12"
											height="12"
											fill="currentColor"
											class="chevron-icon transition-transform duration-150 ease-in-out"
											class:rotate-[-90deg]={isCollapsed}
											viewBox="0 0 16 16"
										>
											<path
												d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
											/>
										</svg>
									</span>
									<span class="font-normal text-inherit">{group.name}</span>
									<span
										data-divider-tooltip="true"
										class="delayed-tooltip fixed z-20 mt-0 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
										style={`left: ${dividerTooltipX}px; top: ${dividerTooltipY}px;`}
									>
										Collapse
									</span>
									<div
										class="flex-1 border-t border-neutral-200 transition group-hover:border-neutral-800"
									></div>
								</button>
								{#if !collapsedPropertyGroups[getPropertyGroupKey(section.id, group.name)]}
									<div class="mb-2">
										{#each group.items as item}
											<a
												class={`block w-full px-6 py-2 text-left transition ${
													getRowIssueId(item) === hoveredIssueId ? 'bg-stone-50' : ''
												}`}
												href={getIssueHref(item)}
												data-sveltekit-preload-data="hover"
												on:click={(event) => handleIssueOpen(event, item)}
												on:mouseenter={() => {
													const id = getRowIssueId(item);
													hoveredIssueId = id;
												}}
												on:mouseleave={() => {
													hoveredIssueId = null;
												}}
											>
												<div class="flex items-center justify-between gap-4">
													<div class="flex min-w-0 flex-1 items-center gap-2.5">
														<div class="relative">
															<button
																type="button"
																class={`tooltip-target relative -m-1 flex items-center justify-center rounded-md p-1 transition ${
																	canEditIssue && !item.isSubIssue
																		? 'hover:bg-neutral-100'
																		: 'cursor-not-allowed'
																}`}
																on:click|stopPropagation|preventDefault={() => {
																	if (!canEditIssue || item.isSubIssue) return;
																	const id = getRowIssueId(item);
																	urgentMenuOpenId = urgentMenuOpenId === id ? null : id;
																	statusMenuOpenId = null;
																}}
															>
																{#if urgentMenuOpenId !== getRowIssueId(item)}
																	<span
																		class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
																	>
																		{item.isSubIssue
																			? 'Change urgency in root issue'
																			: 'Change urgency'}
																	</span>
																{/if}
																{#if item.isSubIssue ? (item.root_urgent ?? item.urgent) : item.urgent}
																	<span
																		class={`flex items-center justify-center text-rose-500 ${item.isSubIssue ? 'opacity-50' : ''}`}
																		style="width: 16px; height: 16px;"
																	>
																		<svg
																			xmlns="http://www.w3.org/2000/svg"
																			width="12"
																			height="12"
																			fill="currentColor"
																			viewBox="0 0 16 16"
																		>
																			<path
																				d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm6 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
																			/>
																		</svg>
																	</span>
																{:else}
																	<span
																		class={`flex items-center justify-center text-neutral-400 ${item.isSubIssue ? 'opacity-50' : ''}`}
																		style="width: 16px; height: 16px;"
																	>
																		<svg
																			xmlns="http://www.w3.org/2000/svg"
																			width="14"
																			height="14"
																			fill="currentColor"
																			viewBox="0 0 16 16"
																		>
																			<path
																				d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm2.5 7.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1"
																			/>
																		</svg>
																	</span>
																{/if}
															</button>
															{#if urgentMenuOpenId === getRowIssueId(item)}
																<div
																	class="absolute left-0 z-20 mt-2 w-48 origin-top-left rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
																	on:click|stopPropagation
																>
																	<div class="sr-only">Change urgency</div>
																	<button
																		type="button"
																		class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																			item.urgent ? 'bg-neutral-50' : ''
																		}`}
																		on:click|preventDefault={() => handleUrgentSelect(item, true)}
																	>
																		<svg
																			xmlns="http://www.w3.org/2000/svg"
																			width="14"
																			height="14"
																			fill="currentColor"
																			class="text-rose-500"
																			viewBox="0 0 16 16"
																		>
																			<path
																				d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm6 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
																			/>
																		</svg>
																		<span>Urgent</span>
																	</button>
																	<button
																		type="button"
																		class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																			!item.urgent ? 'bg-neutral-50' : ''
																		}`}
																		on:click|preventDefault={() => handleUrgentSelect(item, false)}
																	>
																		<svg
																			xmlns="http://www.w3.org/2000/svg"
																			width="14"
																			height="14"
																			fill="currentColor"
																			class="text-neutral-400"
																			viewBox="0 0 16 16"
																		>
																			<path
																				d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm2.5 7.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1"
																			/>
																		</svg>
																		<span>Not urgent</span>
																	</button>
																</div>
															{/if}
														</div>
														<div class="relative">
															<button
																type="button"
																class={`tooltip-target relative -m-1 flex items-center justify-center rounded-md p-1 transition ${
																	canEditIssue
																		? 'hover:bg-neutral-100'
																		: 'cursor-not-allowed opacity-60'
																}`}
																on:click|stopPropagation|preventDefault={() => {
																	if (!canEditIssue) return;
																	const id = getRowIssueId(item);
																	statusMenuOpenId = statusMenuOpenId === id ? null : id;
																	urgentMenuOpenId = null;
																}}
															>
																{#if statusMenuOpenId !== getRowIssueId(item)}
																	<span
																		class="delayed-tooltip absolute top-full left-0 z-20 mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
																	>
																		Change status
																	</span>
																{/if}
																<span
																	class={`h-4 w-4 rounded-full border-[1.5px] ${
																		statusClassByKey[item.status] ?? section.statusClass
																	}`}
																></span>
															</button>
															{#if statusMenuOpenId === getRowIssueId(item)}
																<div
																	class="absolute left-0 z-20 mt-2 w-48 origin-top-left rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
																	on:click|stopPropagation
																>
																	<div class="sr-only">Change status</div>
																	{#each statusOptions as option}
																		<button
																			type="button"
																			class={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
																				item.status === option.value ? 'bg-neutral-50' : ''
																			}`}
																			on:click|preventDefault={() =>
																				handleStatusSelect(item, option.value)}
																		>
																			<span
																				class={`h-3.5 w-3.5 rounded-full border-[1.5px] ${
																					statusClassByKey[option.value]
																				}`}
																			></span>
																			<span>{option.label}</span>
																		</button>
																	{/each}
																</div>
															{/if}
														</div>
														{#if item.isSubIssue}
															<div class="flex min-w-0 items-center gap-2 text-base">
																<div class="flex min-w-0 items-center gap-2">
																	<span
																		class="truncate text-neutral-600 sm:overflow-visible sm:whitespace-normal"
																	>
																		{item.title}
																	</span>
																	{#if hasUnseenUpdates(item)}
																		<span
																			class="h-2 w-2 shrink-0 rounded-full bg-sky-500"
																			aria-label="Issue has updates"
																		></span>
																	{/if}
																</div>
																<span class="hidden text-neutral-300 sm:inline">›</span>
																<span class="hidden text-neutral-400 sm:inline"
																	>{item.parentTitle}</span
																>
															</div>
														{:else}
															<div class="flex items-center gap-2">
																<span
																	class="truncate text-base text-neutral-800 sm:overflow-visible sm:whitespace-normal"
																>
																	{item.title}
																</span>
																{#if hasUnseenUpdates(item)}
																	<span
																		class="h-2 w-2 shrink-0 rounded-full bg-sky-500"
																		aria-label="Issue has updates"
																	></span>
																{/if}
															</div>
														{/if}
													</div>
													<div class="flex items-center gap-2">
														{#if getCreatedAgeLabel(item.created_at ?? item.createdAt, item.latestActivityAt ?? item.updated_at ?? item.updatedAt)}
															<div class="flex items-center gap-1 text-xs text-red-300">
																<svg
																	xmlns="http://www.w3.org/2000/svg"
																	width="12"
																	height="12"
																	fill="currentColor"
																	class="text-red-300"
																	viewBox="0 0 16 16"
																	aria-hidden="true"
																>
																	<path
																		d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71z"
																	/>
																	<path
																		d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16m7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0"
																	/>
																</svg>
																<span>
																	{getCreatedAgeLabel(
																		item.created_at ?? item.createdAt,
																		item.latestActivityAt ?? item.updated_at ?? item.updatedAt
																	)}
																</span>
															</div>
														{/if}
														<div
															class="inline-flex items-center overflow-hidden rounded-full border border-neutral-200 bg-white text-sm text-neutral-500"
														>
															<span class="flex items-center gap-1 px-2.5 py-1">
																<svg
																	xmlns="http://www.w3.org/2000/svg"
																	width="14"
																	height="14"
																	fill="currentColor"
																	class="text-neutral-400"
																	viewBox="0 0 16 16"
																	aria-hidden="true"
																>
																	<path
																		d="M6.5 14.5v-3.505c0-.245.25-.495.5-.495h2c.25 0 .5.25.5.5v3.5a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.146-.354L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293L8.354 1.146a.5.5 0 0 0-.708 0l-6 6A.5.5 0 0 0 1.5 7.5v7a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5"
																	/>
																</svg>
																<span>{getUnitDisplay(item.unit)}</span>
															</span>
														</div>
														{#if item.assigneeBadge}
															<div
																class={`hidden h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold text-neutral-700 sm:flex ${item.assigneeBadge.color}`}
																aria-label={item.assigneeBadge.name}
																title={item.assigneeBadge.name}
															>
																{item.assigneeBadge.initial}
															</div>
														{:else}
															<div
																class="hidden h-6 w-6 items-center justify-center rounded-full text-neutral-300 sm:flex"
																aria-label="Unassigned"
																title="Unassigned"
															>
																<svg
																	xmlns="http://www.w3.org/2000/svg"
																	width="18"
																	height="18"
																	fill="currentColor"
																	class="bi bi-person-circle"
																	viewBox="0 0 16 16"
																>
																	<path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0" />
																	<path
																		fill-rule="evenodd"
																		d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1"
																	/>
																</svg>
															</div>
														{/if}
													</div>
												</div>
											</a>
										{/each}
									</div>
								{/if}
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

{#if showUrgencyPolicyPrompt}
	<div class="fixed inset-0 z-40 bg-neutral-900/30" on:click={closeUrgencyPolicyPrompt}></div>
	<div class="fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-labelledby="urgency-policy-title"
			on:click|stopPropagation
		>
			<div class="flex items-start justify-between gap-4">
				<div>
					<div id="urgency-policy-title" class="text-lg font-medium text-neutral-800">
						Update urgency policy?
					</div>
					<p class="mt-1 text-xs text-neutral-500">
						Apply this urgency setting to future issues like this.
					</p>
				</div>
				<button
					class="text-neutral-400 transition hover:text-neutral-600"
					on:click={closeUrgencyPolicyPrompt}
					aria-label="Close"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-5 w-5">
						<path
							fill="currentColor"
							d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12l-4.9 4.89a1 1 0 1 0 1.41 1.42L12 13.41l4.89 4.9a1 1 0 0 0 1.42-1.41L13.41 12l4.9-4.89a1 1 0 0 0-.01-1.4z"
						/>
					</svg>
				</button>
			</div>
			<div class="mt-4 space-y-3">
				<div>
					<label class="text-xs text-neutral-500">Maintenance issue</label>
					<input
						class="mt-1 w-full rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						bind:value={urgencyPolicyIssue}
						required
						type="text"
					/>
				</div>
				<div>
					<label class="text-xs text-neutral-500">Urgency</label>
					<select
						class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						bind:value={urgencyPolicyValue}
					>
						<option value="urgent">Urgent</option>
						<option value="not_urgent">Not urgent</option>
					</select>
				</div>
				{#if urgencyPolicyError}
					<p class="text-xs text-rose-600">{urgencyPolicyError}</p>
				{/if}
			</div>
			<div class="mt-6 flex items-center justify-end gap-3">
				<button
					type="button"
					class="rounded-full border border-neutral-200 px-4 py-2 text-sm text-neutral-600 transition hover:border-neutral-300"
					on:click={closeUrgencyPolicyPrompt}
					disabled={urgencyPolicyLoading}
				>
					No thanks
				</button>
				<button
					type="button"
					class="rounded-full bg-neutral-900 px-4 py-2 text-sm text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
					on:click={saveUrgencyPolicy}
					disabled={urgencyPolicyLoading}
				>
					{#if urgencyPolicyLoading}
						Saving...
					{:else}
						{urgencyPolicyMatchingId ? 'Update policy' : 'Create policy'}
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if showNewIssueModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/20"
		transition:fade={{ duration: 120 }}
		on:click={closeNewIssueModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.9 }}
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
		>
			<form on:submit|preventDefault={handleCreateIssue}>
				<div class="flex items-center justify-between">
					<div class="text-lg font-medium text-neutral-800">New issue</div>
					<button
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeNewIssueModal}
						type="button"
						aria-label="Close"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="24"
							height="24"
							fill="currentColor"
							viewBox="0 0 16 16"
						>
							<path
								d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"
							/>
						</svg>
					</button>
				</div>
				<div class="mt-5 flex flex-col gap-3">
					{#if createIssueError}
						<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">
							{createIssueError}
						</p>
					{/if}
					<input
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Issue title"
						name="name"
						bind:value={newIssueTitle}
						required
						type="text"
					/>
					<textarea
						class="min-h-[96px] rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Description (optional)"
						name="description"
						bind:value={newIssueDescription}
					></textarea>
					<div>
						<label class="text-xs text-neutral-500">Property</label>
						<select
							class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							bind:value={newIssuePropertyId}
							on:change={handlePropertyChange}
							required
							disabled={!properties.length}
						>
							<option value="" disabled>
								{properties.length ? 'Select a property' : 'No properties available'}
							</option>
							{#each properties as property}
								<option value={property.id}>{property.name}</option>
							{/each}
						</select>
					</div>
					<div>
						<label class="text-xs text-neutral-500">Unit</label>
						<select
							class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
							bind:value={newIssueUnitId}
							disabled={!availableUnits.length}
						>
							<option value="" disabled>
								{availableUnits.length ? 'Select a unit' : 'No units available'}
							</option>
							{#each availableUnits as unit}
								<option value={unit.id}>{unit.name}</option>
							{/each}
						</select>
					</div>
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<label class="text-xs text-neutral-500">Status</label>
							<select
								class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
								bind:value={newIssueStatus}
								required
							>
								{#each statusOptions as option}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</div>
						<div>
							<label class="text-xs text-neutral-500">Assignee</label>
							<select
								class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
								bind:value={newIssueAssigneeId}
							>
								<option value="">Unassigned</option>
								{#each members as member}
									<option value={member.user_id}>
										{member.users?.name ?? member.name ?? 'Member'}
									</option>
								{/each}
							</select>
						</div>
					</div>
				</div>
				<div class="mt-5 flex items-center justify-end gap-2">
					<button
						class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeNewIssueModal}
						type="button"
					>
						Cancel
					</button>
					<button
						class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
						disabled={creatingIssue || !newIssueTitle.trim() || !newIssuePropertyId}
						type="submit"
					>
						{creatingIssue ? 'Creating...' : 'Create issue'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
