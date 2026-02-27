<script>
	// @ts-nocheck
	import { fade, fly } from 'svelte/transition';
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { supabase } from '$lib/supabaseClient';
	import MessageThread from '$lib/components/MessageThread.svelte';
	export let issues = [];
	export let threadsByIssue = {};
	export let messagesByThread = {};
	export let gmailUser = { connected: false, name: 'Connect Gmail', email: null };
	export let connections = [];
	export let buildings = [];
	export let vendors = [];
	export let units = [];
	export let tenants = [];
	export let actions = [];
	export let connectHref = '/agentmvp/gmail/connect';
	export let realtimeAccessToken = null;
	export let basePath = '';
	export let routeView = null;
	export let workspaceName = null;

	const urgencyBuckets = [
		{ key: 'high', label: 'High', dot: 'bg-red-500' },
		{ key: 'medium', label: 'Medium', dot: 'bg-amber-400' },
		{ key: 'low', label: 'Low', dot: 'bg-emerald-500' }
	];

	const statusStyles = {
		todo: 'bg-neutral-200 text-neutral-700 border-neutral-300',
		in_progress: 'bg-sky-100 text-sky-800 border-sky-200',
		done: 'bg-emerald-100 text-emerald-800 border-emerald-200'
	};

	let selectedIssueId = issues[0]?.id ?? null;
	let view = 'my-issues';
	let openDropdownId = null;
	let selectedBuildingId = buildings[0]?.id ?? null;
	let selectedVendorId = vendors[0]?.id ?? null;
	let showNewBuildingModal = false;
	let newBuildingName = '';
	let newBuildingAddress = '';
	let showNewUnitModal = false;
	let newUnitName = '';
	let showNewTenantModal = false;
	let newTenantName = '';
	let newTenantEmail = '';
	let editingTenantId = null;
	let isEditingTenant = false;
	let selectedUnitId = null;
	let showNewVendorModal = false;
	let newVendorName = '';
	let newVendorEmail = '';
	let vendorNoteDraft = '';
	let lastVendorId = null;
	let isSavingVendor = false;
	let vendorSaveTimer = null;
	let vendorEmailDraft = '';
	let vendorPhoneDraft = '';
	let vendorTradeDraft = '';
	let expandedUnitIds = new Set();
	let autoExpandedBuildingId = null;
	let sendingActionIds = new Set();
	const sectionTitles = {
		issues: 'Issues',
		'my-issues': 'My issues',
		building: 'Properties',
		'building-new': 'Properties',
		vendor: 'Vendors',
		inbox: 'Inbox',
		account: 'Account'
	};
	let hoveredSection = null;
	let collapsedSections = {
		issues: false,
		buildings: false,
		vendors: false
	};
	let hoveredRow = null;
	let openRowMenu = null;
	let editingRow = null;
	let editValue = '';
	const routableViews = new Set(['inbox', 'my-issues', 'issues', 'building', 'vendor', 'account']);

	const setView = (next, options = {}) => {
		if (!next || next === view) return;
		view = next;
		if (!options?.skipRoute) {
			navigateToView(next);
		}
	};

	const normalizeView = (value) => {
		if (!value) return 'my-issues';
		return routableViews.has(value) ? value : 'inbox';
	};

	const normalizeBasePath = (value) => {
		if (!value) return '';
		return value.endsWith('/') ? value.slice(0, -1) : value;
	};

	const navigateToView = (next) => {
		const normalizedBase = normalizeBasePath(basePath);
		if (!normalizedBase) return;
		if (!routableViews.has(next)) return;
		const target = `${normalizedBase}/${next}`;
		if ($page.url.pathname !== target) {
			goto(target, { keepfocus: true, noScroll: true });
		}
	};

	$: isIssuesView = view === 'issues' || view === 'my-issues';
	// Check if selected issue has a pending invoice
	$: hasInvoice = false;

	// Get invoices for selected vendor
	$: vendorInvoices = [];

	let invoiceStatus = 'pending'; // pending | approved | denied

	$: inboxNotificationCount = (actions ?? []).filter(
		(action) => action?.status === 'pending'
	).length;

	$: if (basePath) {
		const normalized = normalizeView(routeView);
		if (normalized !== view) {
			setView(normalized, { skipRoute: true });
		}
	}

	$: if (actions?.length) {
		const missingScheduleDrafts = actions.filter(
			(action) => action?.actionType === 'schedule_vendor' && !action?.emailBody
		);
		if (missingScheduleDrafts.length) {
			console.log('schedule_vendor missing email_body', missingScheduleDrafts);
		}
	}

	const issuePriorityRank = (issue) => {
		if (issue?.status === 'todo') return 0;
		if (issue?.status === 'in_progress') return 1;
		if (issue?.status === 'done') return 2;
		return 3;
	};

	$: sortedIssues = [...issues].sort((a, b) => {
		const rankA = issuePriorityRank(a);
		const rankB = issuePriorityRank(b);
		if (rankA !== rankB) return rankA - rankB;
		const timeA = a?.updatedAt ? new Date(a.updatedAt).getTime() : 0;
		const timeB = b?.updatedAt ? new Date(b.updatedAt).getTime() : 0;
		if (timeA !== timeB) return timeB - timeA;
		return (a?.name ?? '').localeCompare(b?.name ?? '');
	});

	$: if (!selectedIssueId && sortedIssues.length && isIssuesView) {
		selectedIssueId = sortedIssues[0].id;
	}

	$: if (!selectedBuildingId && buildings.length && view === 'building') {
		selectedBuildingId = buildings[0].id;
	}

	$: if (selectedBuildingId && units.length && autoExpandedBuildingId !== selectedBuildingId) {
		const firstUnit = units.find((unit) => unit.building_id === selectedBuildingId);
		expandedUnitIds = firstUnit ? new Set([firstUnit.id]) : new Set();
		autoExpandedBuildingId = selectedBuildingId;
	}

	$: if (!selectedVendorId && vendors.length && view === 'vendor') {
		selectedVendorId = vendors[0].id;
	}

	$: selectedIssue = issues.find((issue) => issue.id === selectedIssueId) ?? null;
	$: selectedBuilding = buildings.find((building) => building.id === selectedBuildingId) ?? null;
	$: selectedVendor = vendors.find((vendor) => vendor.id === selectedVendorId) ?? null;
	$: selectedTenant = tenants.find((tenant) => tenant.id === selectedIssue?.tenantId) ??
		tenants.find((tenant) => tenant.unit_id === selectedIssue?.unitId) ?? {
			name: 'Tenant',
			email: ''
		};
	$: assignedVendor = selectedIssue?.vendorId
		? (vendors.find((vendor) => vendor.id === selectedIssue.vendorId) ?? null)
		: null;
	$: assignedVendorName = assignedVendor?.name ?? null;
	$: assignedVendorContact = assignedVendorName
		? { name: assignedVendorName, email: assignedVendor?.email ?? '' }
		: null;
	$: if (selectedVendor?.id && selectedVendor.id !== lastVendorId) {
		vendorNoteDraft = selectedVendor.note ?? '';
		vendorEmailDraft = selectedVendor.email ?? '';
		vendorPhoneDraft = selectedVendor.phone ?? '';
		vendorTradeDraft = selectedVendor.trade ?? '';
		lastVendorId = selectedVendor.id;
	}
	$: tenantThreadId = selectedIssue ? threadsByIssue[selectedIssue.id]?.tenant : null;
	$: vendorThreadId = selectedIssue ? threadsByIssue[selectedIssue.id]?.vendor : null;
	$: rawTenantThreadMessages = tenantThreadId ? (messagesByThread[tenantThreadId] ?? []) : [];
	$: rawVendorThreadMessages = vendorThreadId ? (messagesByThread[vendorThreadId] ?? []) : [];
	const resolveMessageLane = (message) => {
		const channel = message?.channel;
		if (channel === 'tenant' || channel === 'vendor') return channel;
		return message?.sender === 'vendor' ? 'vendor' : 'tenant';
	};
	const withRecipient = (message, lane) => {
		if (!message || message?.sender !== 'agent') return message;
		if (lane === 'vendor') {
			return {
				...message,
				toName: assignedVendorName ?? 'Vendor',
				toEmail: assignedVendor?.email ?? ''
			};
		}
		return {
			...message,
			toName: selectedTenant?.name ?? 'Tenant',
			toEmail: selectedTenant?.email ?? ''
		};
	};
	$: tenantThreadMessages = (
		vendorThreadId
			? rawTenantThreadMessages.filter((message) => resolveMessageLane(message) === 'tenant')
			: rawTenantThreadMessages
	).map((message) => withRecipient(message, 'tenant'));
	$: vendorThreadMessages = rawVendorThreadMessages
		.map((message) => withRecipient(message, 'vendor'))
		.filter((message) => resolveMessageLane(message) === 'vendor');
	$: issueActions = selectedIssue
		? actions.filter((action) => action.issueId === selectedIssue.id && action.status === 'pending')
		: [];
	$: tenantInlineActions = issueActions.filter((action) => action.actionType !== 'schedule_vendor');
	$: vendorInlineActions = issueActions.filter((action) => action.actionType === 'schedule_vendor');
	$: suggestedVendorRecipients = (() => {
		const vendorsByEmail = new Map();
		for (const vendor of vendors ?? []) {
			if (!vendor?.email) continue;
			const key = vendor.email.toLowerCase();
			const existing = vendorsByEmail.get(key) ?? [];
			existing.push(vendor);
			vendorsByEmail.set(key, existing);
		}
		const emails = vendorInlineActions
			.flatMap((action) =>
				action.vendorEmailTo ? action.vendorEmailTo.split(',').map((entry) => entry.trim()) : []
			)
			.filter(Boolean);
		const unique = Array.from(new Set(emails.map((email) => email.toLowerCase())));
		return unique.map((email) => {
			const matches = vendorsByEmail.get(email) ?? [];
			const cleanerMatch = matches.find(
				(candidate) => candidate?.trade?.toLowerCase() === 'cleaner'
			);
			const vendor = cleanerMatch ?? matches[0] ?? null;
			return {
				id: vendor?.id ?? null,
				name: vendor?.name ?? null,
				email,
				trade: vendor?.trade ?? null,
				phone: vendor?.phone ?? null
			};
		});
	})();
	$: sectionTitle = sectionTitles[view] ?? 'Overview';

	const formatTimestamp = (timestamp) => {
		if (!timestamp) return '';
		const date = new Date(timestamp);
		return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
	};

	const actionTypeLabel = (type) =>
		type === 'schedule_vendor' ? 'Schedule Vendor' : 'Triage Issue';

	const titleCaseSender = (sender) => (sender ? sender[0].toUpperCase() + sender.slice(1) : '');
	const titleCaseWords = (value) =>
		value
			? value
					.split(' ')
					.map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ''))
					.join(' ')
			: '';
	const modeLabel = (mode) => {
		if (mode === 'read') return 'Read';
		if (mode === 'write') return 'Write';
		return 'Both';
	};

	const formatVendorRecipients = (action) => {
		if (action?.vendorEmailTo) {
			const vendorsByEmail = new Map();
			for (const vendor of vendors ?? []) {
				if (!vendor?.email) continue;
				const key = vendor.email.toLowerCase();
				const existing = vendorsByEmail.get(key) ?? [];
				existing.push(vendor);
				vendorsByEmail.set(key, existing);
			}
			return action.vendorEmailTo
				.split(',')
				.map((entry) => entry.trim())
				.filter(Boolean)
				.map((email) => {
					const matches = vendorsByEmail.get(email.toLowerCase()) ?? [];
					const cleanerMatch = matches.find(
						(candidate) => candidate?.trade?.toLowerCase() === 'cleaner'
					);
					const vendor = cleanerMatch ?? matches[0] ?? null;
					return vendor?.name ? `${vendor.name} <${email}>` : email;
				})
				.join(', ');
		}
		if (action?.vendorEmail) {
			return action.vendorName
				? `${action.vendorName} <${action.vendorEmail}>`
				: action.vendorEmail;
		}
		return action?.vendorName ?? 'Vendor';
	};

	const inlineActionRecipient = (action, lane) => {
		if (lane === 'vendor') {
			if (action?.vendorEmailTo) {
				return {
					toName: formatVendorRecipients(action),
					toEmail: ''
				};
			}
			return {
				toName: action?.vendorName ?? action?.vendorEmail ?? 'Vendor',
				toEmail: action?.vendorEmail ?? ''
			};
		}
		return {
			toName: action?.tenantName ?? action?.tenantEmail ?? 'Tenant',
			toEmail: action?.tenantEmail ?? ''
		};
	};

	const inlineActionFromLabel = () => gmailUser?.name ?? gmailUser?.email ?? 'Bedrock Ops';

	const postAction = async (action, formData) => {
		const response = await fetch(action, {
			method: 'POST',
			body: formData
		});
		if (!response.ok) {
			throw new Error(`Request failed: ${response.status}`);
		}
		return response;
	};

	let realtimeChannel = null;
	let latestMessageByThread = new Map();
	let threadIssueMap = new Map();

	const normalizeIssueRow = (row) => {
		const unit = units.find((item) => item.id === row.unit_id);
		const building = unit ? buildings.find((item) => item.id === unit.building_id) : null;
		const vendor = row.vendor_id ? vendors.find((item) => item.id === row.vendor_id) : null;
		const suggestedVendor = row.suggested_vendor_id
			? vendors.find((item) => item.id === row.suggested_vendor_id)
			: null;
		const tenant = row.tenant_id ? tenants.find((item) => item.id === row.tenant_id) : null;
		return {
			id: row.id,
			name: row.name,
			urgency: row.urgency ?? null,
			status: row.status,
			description: row.description ?? null,
			vendorId: row.vendor_id ?? null,
			suggestedVendorId: row.suggested_vendor_id ?? null,
			unitId: row.unit_id ?? null,
			tenantId: row.tenant_id ?? null,
			unit: unit?.name ?? 'Unknown',
			building: building?.name ?? 'Unknown',
			vendorName: vendor?.name ?? null,
			vendorEmail: vendor?.email ?? null,
			suggestedVendorName: suggestedVendor?.name ?? null,
			suggestedVendorEmail: suggestedVendor?.email ?? null,
			tenantName: tenant?.name ?? null,
			tenantEmail: tenant?.email ?? null
		};
	};

	const normalizeActionRow = (row, issueOverride = null) => {
		const issue = issueOverride ?? issues.find((item) => item.id === row.issue_id) ?? null;
		return {
			id: row.id,
			issueId: row.issue_id ?? null,
			actionType: row.action_type ?? 'triage_issue',
			title: row.title,
			detail: row.detail,
			emailBody: row.email_body ?? '',
			vendorEmailTo: row.vendor_email_to ?? null,
			status: row.status,
			createdAt: row.created_at,
			issueName: issue?.name ?? 'Unknown issue',
			issueUrgency: issue?.urgency ?? null,
			issueStatus: issue?.status ?? null,
			unit: issue?.unit ?? null,
			building: issue?.building ?? null,
			vendorName: issue?.suggestedVendorName ?? issue?.vendorName ?? null,
			vendorEmail: issue?.suggestedVendorEmail ?? issue?.vendorEmail ?? null,
			tenantName: issue?.tenantName ?? null,
			tenantEmail: issue?.tenantEmail ?? null
		};
	};

	const rebuildRealtimeMaps = () => {
		latestMessageByThread = new Map();
		for (const [threadId, messageList] of Object.entries(messagesByThread ?? {})) {
			let latest = 0;
			for (const message of messageList ?? []) {
				const timestamp = message?.timestamp ? new Date(message.timestamp).getTime() : 0;
				if (timestamp > latest) latest = timestamp;
			}
			latestMessageByThread.set(threadId, latest);
		}

		threadIssueMap = new Map();
		for (const [issueId, threadValue] of Object.entries(threadsByIssue ?? {})) {
			const tenantThreadId = threadValue?.tenant ?? null;
			const vendorThreadId = threadValue?.vendor ?? null;
			if (tenantThreadId) threadIssueMap.set(tenantThreadId, issueId);
			if (vendorThreadId) threadIssueMap.set(vendorThreadId, issueId);
		}
	};

	onMount(async () => {
		const accessToken = realtimeAccessToken
			? realtimeAccessToken
			: (await supabase.auth.getSession()).data?.session?.access_token;
		if (accessToken) {
			supabase.realtime.setAuth(accessToken);
		}
		rebuildRealtimeMaps();
		realtimeChannel = supabase
			.channel('issue-dashboard')
			.on('postgres_changes', { event: '*', schema: 'public', table: 'issues' }, (payload) => {
				if (payload.eventType === 'DELETE') {
					const removedId = payload.old?.id;
					if (!removedId) return;
					issues = issues.filter((issue) => issue.id !== removedId);
					actions = actions.filter((action) => action.issueId !== removedId);
					if (threadsByIssue?.[removedId]) {
						const nextThreads = { ...threadsByIssue };
						delete nextThreads[removedId];
						threadsByIssue = nextThreads;
					}
					if (selectedIssueId === removedId) {
						selectedIssueId = issues[0]?.id ?? null;
					}
					return;
				}

				const normalized = normalizeIssueRow(payload.new);
				const existingIndex = issues.findIndex((issue) => issue.id === normalized.id);
				if (existingIndex >= 0) {
					issues = issues.map((issue) => (issue.id === normalized.id ? normalized : issue));
				} else {
					issues = [normalized, ...issues];
					if (!selectedIssueId && isIssuesView) {
						selectedIssueId = normalized.id;
					}
				}

				actions = actions.map((action) =>
					action.issueId === normalized.id
						? normalizeActionRow(
								{
									id: action.id,
									issue_id: action.issueId,
									action_type: action.actionType,
									title: action.title,
									detail: action.detail,
									email_body: action.emailBody,
									vendor_email_to: action.vendorEmailTo,
									status: action.status,
									created_at: action.createdAt
								},
								normalized
							)
						: action
				);
			})
			.on('postgres_changes', { event: '*', schema: 'public', table: 'threads' }, (payload) => {
				if (payload.eventType === 'DELETE') {
					const removedId = payload.old?.id;
					if (removedId && threadIssueMap.has(removedId)) {
						threadIssueMap.delete(removedId);
					}
					return;
				}
				const row = payload.new;
				if (!row?.id || !row?.issue_id) return;
				const participantType = row.participant_type === 'vendor' ? 'vendor' : 'tenant';
				threadIssueMap.set(row.id, row.issue_id);
				threadsByIssue = {
					...threadsByIssue,
					[row.issue_id]: {
						...(threadsByIssue?.[row.issue_id] ?? { tenant: null, vendor: null }),
						[participantType]: row.id
					}
				};
			})
			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'messages' },
				async (payload) => {
					if (payload.eventType === 'DELETE') {
						const removedId = payload.old?.id;
						const threadId = payload.old?.thread_id;
						if (!removedId || !threadId) return;
						const existing = messagesByThread[threadId] ?? [];
						const nextMessages = existing.filter((item) => item.id !== removedId);
						messagesByThread = { ...messagesByThread, [threadId]: nextMessages };
						rebuildRealtimeMaps();
						return;
					}
					const row = payload.new;
					if (!row?.id || !row?.thread_id) return;
					const threadId = row.thread_id;
					if (!threadIssueMap.has(threadId)) {
						const { data: threadRow } = await supabase
							.from('threads')
							.select('id, issue_id, participant_type')
							.eq('id', threadId)
							.maybeSingle();
						if (threadRow?.issue_id) {
							const participantType = threadRow.participant_type === 'vendor' ? 'vendor' : 'tenant';
							threadIssueMap.set(threadRow.id, threadRow.issue_id);
							threadsByIssue = {
								...threadsByIssue,
								[threadRow.issue_id]: {
									...(threadsByIssue?.[threadRow.issue_id] ?? { tenant: null, vendor: null }),
									[participantType]: threadRow.id
								}
							};
						}
					}
					const existing = messagesByThread[threadId] ?? [];
					const existingIndex = existing.findIndex((item) => item.id === row.id);
					let nextMessages = [];
					if (existingIndex >= 0) {
						nextMessages = existing.map((item) => (item.id === row.id ? row : item));
					} else {
						nextMessages = [...existing, row];
					}
					nextMessages.sort((a, b) => {
						const aTime = a?.timestamp ? new Date(a.timestamp).getTime() : 0;
						const bTime = b?.timestamp ? new Date(b.timestamp).getTime() : 0;
						return aTime - bTime;
					});
					messagesByThread = { ...messagesByThread, [threadId]: nextMessages };
					const timestamp = row?.timestamp ? new Date(row.timestamp).getTime() : 0;
					latestMessageByThread.set(threadId, timestamp);
				}
			)
			.on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
				if (payload.eventType === 'DELETE') {
					const removedId = payload.old?.id;
					if (!removedId) return;
					actions = actions.filter((action) => action.id !== removedId);
					return;
				}
				const row = payload.new;
				if (!row?.id) return;
				if (row.status !== 'pending') {
					actions = actions.filter((action) => action.id !== row.id);
					return;
				}
				const normalized = normalizeActionRow(row);
				const existingIndex = actions.findIndex((action) => action.id === row.id);
				if (existingIndex >= 0) {
					actions = actions.map((action) => (action.id === row.id ? normalized : action));
				} else {
					actions = [normalized, ...actions];
				}
			})
			.subscribe((status) => {
				if (import.meta.env.DEV) {
					console.log('realtime status', status);
				}
			});
	});

	onDestroy(() => {
		if (realtimeChannel) {
			supabase.removeChannel(realtimeChannel);
			realtimeChannel = null;
		}
	});

	const handleModeChange = async (connectionId, nextMode) => {
		if (!connectionId) return;
		const formData = new FormData();
		formData.set('connection_id', connectionId);
		formData.set('mode', nextMode);
		await postAction('?/updateConnection', formData);
		connections = connections.map((connection) => {
			if (connection.id === connectionId) {
				return { ...connection, mode: nextMode };
			}
			if (nextMode === 'write' && connection.mode === 'write') {
				return { ...connection, mode: 'read' };
			}
			return connection;
		});
		openDropdownId = null;
	};

	const handleDisconnect = async (connectionId) => {
		if (!connectionId) return;
		const formData = new FormData();
		formData.set('connection_id', connectionId);
		await postAction('?/disconnectConnection', formData);
		connections = connections.filter((connection) => connection.id !== connectionId);
	};

	const toggleDropdown = (connectionId) => {
		openDropdownId = openDropdownId === connectionId ? null : connectionId;
	};

	const handleSignOut = async (event) => {
		event.preventDefault();
		await postAction('?/signOut', new FormData());
		window.location.href = '/agentmvp';
	};

	const handleDeleteAccount = async (event) => {
		event.preventDefault();
		await postAction('?/deleteAccount', new FormData());
		window.location.href = '/agentmvp';
	};

	const handleResetIssues = async (event) => {
		event.preventDefault();
		await postAction('?/resetIssues', new FormData());
		issues = [];
		threadsByIssue = {};
		messagesByThread = {};
		selectedIssueId = null;
	};

	const handleIssueSelect = (issueId) => {
		selectedIssueId = issueId;
		selectedBuildingId = null;
		selectedVendorId = null;
		setView(view === 'my-issues' ? 'my-issues' : 'issues');
	};

	const handleActionIssueOpen = (issueId) => {
		if (!issueId) return;
		handleIssueSelect(issueId);
	};

	const handleApproveAction = async (actionId) => {
		if (!actionId) return;
		sendingActionIds = new Set([...sendingActionIds, actionId]);
		const action = actions.find((item) => item.id === actionId);
		const formData = new FormData();
		formData.set('action_id', actionId);
		if (action?.emailBody !== undefined) {
			formData.set('email_body', action.emailBody ?? '');
		}
		try {
			await postAction('?/approveAction', formData);
			actions = actions.filter((item) => item.id !== actionId);
		} catch (error) {
			console.error('Failed to approve action', error);
		} finally {
			sendingActionIds = new Set([...sendingActionIds].filter((id) => id !== actionId));
		}
	};

	const handleDenyAction = async (actionId) => {
		if (!actionId) return;
		const formData = new FormData();
		formData.set('action_id', actionId);
		try {
			await postAction('?/denyAction', formData);
			actions = actions.filter((action) => action.id !== actionId);
		} catch (error) {
			console.error('Failed to deny action', error);
		}
	};

	const handleActionDraftSave = async (action) => {
		if (!action?.id) return;
		const formData = new FormData();
		formData.set('action_id', action.id);
		formData.set('email_body', action.emailBody ?? '');
		try {
			await postAction('?/updateActionDraft', formData);
		} catch (error) {
			console.error('Failed to update action draft', error);
		}
	};

	const handleInboxSelect = () => {
		selectedIssueId = null;
		selectedBuildingId = null;
		selectedVendorId = null;
		setView('inbox');
	};

	const handleMyIssuesSelect = () => {
		selectedBuildingId = null;
		selectedVendorId = null;
		if (!selectedIssueId && sortedIssues.length) {
			selectedIssueId = sortedIssues[0].id;
		}
		setView('my-issues');
	};

	const handleBuildingSelect = (buildingId) => {
		selectedBuildingId = buildingId;
		selectedIssueId = null;
		selectedVendorId = null;
		setView('building');
	};

	const handleVendorSelect = (vendorId) => {
		selectedVendorId = vendorId;
		selectedIssueId = null;
		selectedBuildingId = null;
		setView('vendor');
	};

	const toggleSection = (key) => {
		collapsedSections = { ...collapsedSections, [key]: !collapsedSections[key] };
	};

	const rowKey = (type, id) => `${type}:${id}`;

	const toggleRowMenu = (type, id) => {
		const key = rowKey(type, id);
		openRowMenu = openRowMenu === key ? null : key;
	};

	const closeRowMenu = () => {
		openRowMenu = null;
	};

	const startRename = (type, id, currentName) => {
		editingRow = { type, id };
		editValue = currentName;
		openRowMenu = null;
	};

	const cancelRename = () => {
		editingRow = null;
		editValue = '';
	};

	const saveRename = async () => {
		if (!editingRow || !editValue.trim()) return;
		const { type, id } = editingRow;
		const nextName = editValue.trim();
		if (type === 'issues') {
			const previous = issues.find((issue) => issue.id === id)?.name ?? '';
			issues = issues.map((issue) => (issue.id === id ? { ...issue, name: nextName } : issue));
			const formData = new FormData();
			formData.set('issue_id', id);
			formData.set('name', nextName);
			try {
				await postAction('?/renameIssue', formData);
			} catch (error) {
				issues = issues.map((issue) => (issue.id === id ? { ...issue, name: previous } : issue));
				console.error('Failed to rename issue', error);
			}
		}
		if (type === 'buildings') {
			const previous = buildings.find((building) => building.id === id)?.name ?? '';
			buildings = buildings.map((building) =>
				building.id === id ? { ...building, name: nextName } : building
			);
			const formData = new FormData();
			formData.set('building_id', id);
			formData.set('name', nextName);
			try {
				await postAction('?/renameBuilding', formData);
			} catch (error) {
				buildings = buildings.map((building) =>
					building.id === id ? { ...building, name: previous } : building
				);
				console.error('Failed to rename building', error);
			}
		}
		if (type === 'vendors') {
			const previous = vendors.find((vendor) => vendor.id === id)?.name ?? '';
			vendors = vendors.map((vendor) =>
				vendor.id === id ? { ...vendor, name: nextName } : vendor
			);
			const formData = new FormData();
			formData.set('vendor_id', id);
			formData.set('name', nextName);
			try {
				await postAction('?/renameVendor', formData);
			} catch (error) {
				vendors = vendors.map((vendor) =>
					vendor.id === id ? { ...vendor, name: previous } : vendor
				);
				console.error('Failed to rename vendor', error);
			}
		}
		cancelRename();
	};

	const deleteRow = async (type, id) => {
		openRowMenu = null;
		if (type === 'issues') {
			const previous = issues;
			issues = issues.filter((issue) => issue.id !== id);
			if (selectedIssueId === id) {
				selectedIssueId = issues[0]?.id ?? null;
			}
			const formData = new FormData();
			formData.set('issue_id', id);
			try {
				await postAction('?/deleteIssue', formData);
			} catch (error) {
				issues = previous;
				console.error('Failed to delete issue', error);
			}
		}
		if (type === 'buildings') {
			const previous = buildings;
			buildings = buildings.filter((building) => building.id !== id);
			if (selectedBuildingId === id) {
				selectedBuildingId = buildings[0]?.id ?? null;
				setView('issues');
			}
			const formData = new FormData();
			formData.set('building_id', id);
			try {
				await postAction('?/deleteBuilding', formData);
			} catch (error) {
				buildings = previous;
				console.error('Failed to delete building', error);
			}
		}
		if (type === 'vendors') {
			const previous = vendors;
			vendors = vendors.filter((vendor) => vendor.id !== id);
			if (selectedVendorId === id) {
				selectedVendorId = vendors[0]?.id ?? null;
				setView('issues');
			}
			const formData = new FormData();
			formData.set('vendor_id', id);
			try {
				await postAction('?/deleteVendor', formData);
			} catch (error) {
				vendors = previous;
				console.error('Failed to delete vendor', error);
			}
		}
		if (type === 'tenants') {
			const previous = tenants;
			tenants = tenants.filter((tenant) => tenant.id !== id);
			const formData = new FormData();
			formData.set('tenant_id', id);
			try {
				await postAction('?/deleteTenant', formData);
			} catch (error) {
				tenants = previous;
				console.error('Failed to delete tenant', error);
			}
		}
	};

	const handleNewBuilding = () => {
		showNewBuildingModal = true;
	};

	const closeNewBuildingModal = () => {
		showNewBuildingModal = false;
		newBuildingName = '';
		newBuildingAddress = '';
	};

	const openNewUnitModal = () => {
		if (!selectedBuildingId) return;
		showNewUnitModal = true;
	};

	const closeNewUnitModal = () => {
		showNewUnitModal = false;
		newUnitName = '';
	};

	const openNewTenantModal = (unitId) => {
		selectedUnitId = unitId;
		isEditingTenant = false;
		editingTenantId = null;
		showNewTenantModal = true;
	};

	const openEditTenantModal = (tenant) => {
		selectedUnitId = tenant.unit_id;
		newTenantName = tenant.name ?? '';
		newTenantEmail = tenant.email ?? '';
		isEditingTenant = true;
		editingTenantId = tenant.id;
		showNewTenantModal = true;
		closeRowMenu();
	};

	const closeNewTenantModal = () => {
		showNewTenantModal = false;
		newTenantName = '';
		newTenantEmail = '';
		selectedUnitId = null;
		editingTenantId = null;
		isEditingTenant = false;
	};

	const openNewVendorModal = () => {
		showNewVendorModal = true;
	};

	const closeNewVendorModal = () => {
		showNewVendorModal = false;
		newVendorName = '';
		newVendorEmail = '';
	};

	const handleCreateBuilding = async () => {
		if (!newBuildingName.trim()) return;
		const tempId = `temp-${Date.now()}`;
		const optimistic = { id: tempId, name: newBuildingName.trim() };
		buildings = [optimistic, ...buildings];
		selectedBuildingId = tempId;
		selectedIssueId = null;
		setView('building');
		showNewBuildingModal = false;
		const formData = new FormData();
		formData.set('name', newBuildingName.trim());
		if (newBuildingAddress.trim()) {
			formData.set('address', newBuildingAddress.trim());
		}
		newBuildingName = '';
		newBuildingAddress = '';
		try {
			const response = await postAction('?/createBuilding', formData);
			const payload = await response.json();
			if (payload?.building?.id) {
				buildings = buildings.map((building) =>
					building.id === tempId ? payload.building : building
				);
				if (selectedBuildingId === tempId) {
					selectedBuildingId = payload.building.id;
				}
			}
		} catch (error) {
			buildings = buildings.filter((building) => building.id !== tempId);
			if (selectedBuildingId === tempId) {
				selectedBuildingId = buildings[0]?.id ?? null;
			}
			console.error('Failed to create building', error);
		}
	};

	const handleCreateUnit = async () => {
		if (!newUnitName.trim() || !selectedBuildingId) return;
		const tempId = `temp-unit-${Date.now()}`;
		const optimistic = {
			id: tempId,
			name: newUnitName.trim(),
			building_id: selectedBuildingId
		};
		units = [optimistic, ...units];
		showNewUnitModal = false;
		const formData = new FormData();
		formData.set('name', newUnitName.trim());
		formData.set('building_id', selectedBuildingId);
		newUnitName = '';
		try {
			const response = await postAction('?/createUnit', formData);
			const payload = await response.json();
			if (payload?.unit?.id) {
				units = units.map((unit) => (unit.id === tempId ? payload.unit : unit));
			}
		} catch (error) {
			units = units.filter((unit) => unit.id !== tempId);
			console.error('Failed to create unit', error);
		}
	};

	const handleCreateTenant = async () => {
		if (!newTenantName.trim() || !newTenantEmail.trim() || !selectedUnitId) return;
		if (isEditingTenant && editingTenantId) {
			const previous = tenants.find((tenant) => tenant.id === editingTenantId);
			tenants = tenants.map((tenant) =>
				tenant.id === editingTenantId
					? {
							...tenant,
							name: newTenantName.trim(),
							email: newTenantEmail.trim()
						}
					: tenant
			);
			showNewTenantModal = false;
			const formData = new FormData();
			formData.set('tenant_id', editingTenantId);
			formData.set('name', newTenantName.trim());
			formData.set('email', newTenantEmail.trim());
			newTenantName = '';
			newTenantEmail = '';
			selectedUnitId = null;
			editingTenantId = null;
			isEditingTenant = false;
			try {
				const response = await postAction('?/updateTenant', formData);
				const payload = await response.json();
				if (payload?.tenant?.id) {
					tenants = tenants.map((tenant) =>
						tenant.id === payload.tenant.id ? payload.tenant : tenant
					);
				}
			} catch (error) {
				if (previous) {
					tenants = tenants.map((tenant) => (tenant.id === previous.id ? previous : tenant));
				}
				console.error('Failed to update tenant', error);
			}
			return;
		}
		const tempId = `temp-tenant-${Date.now()}`;
		const optimistic = {
			id: tempId,
			name: newTenantName.trim(),
			email: newTenantEmail.trim(),
			unit_id: selectedUnitId
		};
		tenants = [optimistic, ...tenants];
		showNewTenantModal = false;
		const formData = new FormData();
		formData.set('name', newTenantName.trim());
		formData.set('email', newTenantEmail.trim());
		formData.set('unit_id', selectedUnitId);
		newTenantName = '';
		newTenantEmail = '';
		selectedUnitId = null;
		try {
			const response = await postAction('?/createTenant', formData);
			const payload = await response.json();
			if (payload?.tenant?.id) {
				tenants = tenants.map((tenant) => (tenant.id === tempId ? payload.tenant : tenant));
			}
		} catch (error) {
			tenants = tenants.filter((tenant) => tenant.id !== tempId);
			console.error('Failed to create tenant', error);
		}
	};

	const handleCreateVendor = async () => {
		if (!newVendorName.trim()) return;
		const tempId = `temp-vendor-${Date.now()}`;
		const optimistic = { id: tempId, name: newVendorName.trim() };
		vendors = [optimistic, ...vendors];
		showNewVendorModal = false;
		const formData = new FormData();
		formData.set('name', newVendorName.trim());
		if (newVendorEmail.trim()) {
			formData.set('email', newVendorEmail.trim());
		}
		newVendorName = '';
		newVendorEmail = '';
		try {
			const response = await postAction('?/createVendor', formData);
			const payload = await response.json();
			if (payload?.vendor?.id) {
				vendors = vendors.map((vendor) => (vendor.id === tempId ? payload.vendor : vendor));
			}
		} catch (error) {
			vendors = vendors.filter((vendor) => vendor.id !== tempId);
			console.error('Failed to create vendor', error);
		}
	};

	const resetVendorDrafts = () => {
		if (!selectedVendor) return;
		vendorNoteDraft = selectedVendor.note ?? '';
		vendorEmailDraft = selectedVendor.email ?? '';
		vendorPhoneDraft = selectedVendor.phone ?? '';
		vendorTradeDraft = selectedVendor.trade ?? '';
	};

	const handleSaveVendorDetails = async () => {
		if (!selectedVendor?.id) return;
		const previous = {
			email: selectedVendor.email ?? '',
			phone: selectedVendor.phone ?? '',
			trade: selectedVendor.trade ?? '',
			note: selectedVendor.note ?? ''
		};
		const next = {
			email: vendorEmailDraft,
			phone: vendorPhoneDraft,
			trade: vendorTradeDraft,
			note: vendorNoteDraft
		};
		if (
			next.email === previous.email &&
			next.phone === previous.phone &&
			next.trade === previous.trade &&
			next.note === previous.note
		) {
			return;
		}
		isSavingVendor = true;
		if (vendorSaveTimer) {
			clearTimeout(vendorSaveTimer);
			vendorSaveTimer = null;
		}
		vendors = vendors.map((vendor) =>
			vendor.id === selectedVendor.id ? { ...vendor, ...next } : vendor
		);
		const formData = new FormData();
		formData.set('vendor_id', selectedVendor.id);
		formData.set('email', next.email);
		formData.set('phone', next.phone);
		formData.set('trade', next.trade);
		formData.set('note', next.note);
		try {
			const response = await postAction('?/updateVendorDetails', formData);
			const payload = await response.json();
			if (payload?.vendor?.id) {
				vendors = vendors.map((vendor) =>
					vendor.id === payload.vendor.id ? { ...vendor, ...payload.vendor } : vendor
				);
			}
			vendorSaveTimer = setTimeout(() => {
				isSavingVendor = false;
				vendorSaveTimer = null;
			}, 2000);
		} catch (error) {
			vendors = vendors.map((vendor) =>
				vendor.id === selectedVendor.id ? { ...vendor, ...previous } : vendor
			);
			resetVendorDrafts();
			console.error('Failed to update vendor details', error);
			isSavingVendor = false;
		}
	};

	const toggleUnit = (unitId) => {
		if (expandedUnitIds.has(unitId)) {
			expandedUnitIds.delete(unitId);
		} else {
			expandedUnitIds.add(unitId);
		}
		expandedUnitIds = new Set(expandedUnitIds);
	};
</script>

<div class="h-screen bg-white text-neutral-900" on:click={closeRowMenu}>
	<div class="flex h-screen flex-col md:flex-row">
		<aside class="flex h-screen w-1/6 flex-col border-r border-neutral-200 bg-neutral-50/80">
			<div class="flex h-full min-h-0 flex-col">
				<div class="flex flex-col space-y-6 px-2 pt-4">
					<div class="flex items-center justify-between px-2 text-neutral-700">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="20"
							height="20"
							fill="currentColor"
							class="bi bi-hexagon-fill"
							viewBox="0 0 16 16"
						>
							<path
								fill-rule="evenodd"
								d="M8.5.134a1 1 0 0 0-1 0l-6 3.577a1 1 0 0 0-.5.866v6.846a1 1 0 0 0 .5.866l6 3.577a1 1 0 0 0 1 0l6-3.577a1 1 0 0 0 .5-.866V4.577a1 1 0 0 0-.5-.866z"
							/>
						</svg>
						<div class="text-neutral-400">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								fill="currentColor"
								class="bi bi-layout-sidebar"
								viewBox="0 0 16 16"
							>
								<path
									d="M0 3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm5-1v12h9a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zM4 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h2z"
								/>
							</svg>
						</div>
					</div>
					<div class="flex flex-col pb-4">
						<button
							class={`text-md flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition ${view === 'inbox' ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
							on:click={handleInboxSelect}
							type="button"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="20"
								height="20"
								fill="currentColor"
								class="bi bi-inbox"
								viewBox="0 0 16 16"
							>
								<path
									d="M4.98 4a.5.5 0 0 0-.39.188L1.54 8H6a.5.5 0 0 1 .5.5 1.5 1.5 0 1 0 3 0A.5.5 0 0 1 10 8h4.46l-3.05-3.812A.5.5 0 0 0 11.02 4zm9.954 5H10.45a2.5 2.5 0 0 1-4.9 0H1.066l.32 2.562a.5.5 0 0 0 .497.438h12.234a.5.5 0 0 0 .496-.438zM3.809 3.563A1.5 1.5 0 0 1 4.981 3h6.038a1.5 1.5 0 0 1 1.172.563l3.7 4.625a.5.5 0 0 1 .105.374l-.39 3.124A1.5 1.5 0 0 1 14.117 13H1.883a1.5 1.5 0 0 1-1.489-1.314l-.39-3.124a.5.5 0 0 1 .106-.374z"
								/>
							</svg>
							<span class="truncate">Inbox</span>
							{#if inboxNotificationCount > 0}
								<span
									class="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-neutral-200/70 px-1.5 text-[11px] font-semibold text-neutral-700"
									>{inboxNotificationCount}</span
								>
							{/if}
						</button>
						<button
							class={`text-md flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition ${view === 'my-issues' ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
							on:click={handleMyIssuesSelect}
							type="button"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="20"
								height="20"
								fill="currentColor"
								class="bi bi-check2-square"
								viewBox="0 0 16 16"
							>
								<path
									d="M3 1.5A1.5 1.5 0 0 0 1.5 3v10A1.5 1.5 0 0 0 3 14.5h10A1.5 1.5 0 0 0 14.5 13V3A1.5 1.5 0 0 0 13 1.5zm10 1a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"
								/>
								<path
									d="M10.854 5.646a.5.5 0 0 1 0 .708L7.5 9.707 5.146 7.354a.5.5 0 1 1 .708-.708L7.5 8.293l2.646-2.647a.5.5 0 0 1 .708 0"
								/>
							</svg>
							<span class="truncate">My issues</span>
						</button>
					</div>
				</div>
				<div class="min-h-0 flex-1 space-y-4 overflow-y-auto pb-24">
					<div
						class="flex flex-col px-2"
						on:mouseenter={() => (hoveredSection = 'issues')}
						on:mouseleave={() => (hoveredSection = null)}
					>
						<div class="flex items-center justify-between px-2">
							<h1 class="text-sm font-light text-neutral-400">Issues</h1>
							<button
								class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredSection === 'issues' || collapsedSections.issues ? 'opacity-100' : 'opacity-0'}`}
								on:click={() => toggleSection('issues')}
								type="button"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="14"
									height="14"
									fill="currentColor"
									class={`transition ${collapsedSections.issues ? '-rotate-90' : ''}`}
									viewBox="0 0 16 16"
								>
									<path
										d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
									/>
								</svg>
							</button>
						</div>
						{#if !collapsedSections.issues}
							{#if !issues.length}
								<div class="mt-1 px-2 text-sm text-neutral-500">No maintenance issues yet.</div>
							{:else}
								<div class="mt-1 flex-1 space-y-1">
									{#each sortedIssues as issue}
										<div
											class={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-2 text-left text-sm transition ${issue.id === selectedIssueId && isIssuesView ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
											on:mouseenter={() => (hoveredRow = rowKey('issues', issue.id))}
											on:mouseleave={() => (hoveredRow = null)}
											on:click={() => {
												if (editingRow?.type === 'issues' && editingRow?.id === issue.id) return;
												handleIssueSelect(issue.id);
											}}
										>
											{#if editingRow?.type === 'issues' && editingRow?.id === issue.id}
												<div class="flex flex-1 items-center gap-2">
													<span
														class={`h-2 w-2 flex-none rounded-full ${urgencyBuckets.find((bucket) => bucket.key === issue.urgency)?.dot ?? 'bg-neutral-300'}`}
													></span>
													<input
														class="w-full bg-transparent p-0 text-sm text-neutral-900 outline-none"
														bind:value={editValue}
														autofocus
														on:keydown={(event) => {
															if (event.key === 'Enter') saveRename();
															if (event.key === 'Escape') cancelRename();
														}}
														on:blur={cancelRename}
														type="text"
													/>
												</div>
											{:else}
												<button class="flex flex-1 items-center gap-2 text-left" type="button">
													<span
														class={`h-2 w-2 flex-none rounded-full ${urgencyBuckets.find((bucket) => bucket.key === issue.urgency)?.dot ?? 'bg-neutral-300'}`}
													></span>
													<span class="truncate">{issue.name}</span>
												</button>
											{/if}
											<div class="relative">
												<button
													class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredRow === rowKey('issues', issue.id) || openRowMenu === rowKey('issues', issue.id) ? 'opacity-100' : 'opacity-0'}`}
													on:click|stopPropagation={() => toggleRowMenu('issues', issue.id)}
													type="button"
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="16"
														height="16"
														fill="currentColor"
														class="bi bi-three-dots"
														viewBox="0 0 16 16"
													>
														<path
															d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3"
														/>
													</svg>
												</button>
												{#if openRowMenu === rowKey('issues', issue.id)}
													<div
														class="absolute right-0 z-[999] mt-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
														on:click|stopPropagation
													>
														<button
															class="flex w-full px-3 py-2 text-left hover:bg-neutral-50"
															on:click={() => startRename('issues', issue.id, issue.name)}
															type="button"
														>
															Rename
														</button>
														<button
															class="flex w-full px-3 py-2 text-left text-rose-600 hover:bg-neutral-50"
															on:click={() => deleteRow('issues', issue.id)}
															type="button"
														>
															Delete
														</button>
													</div>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{/if}
						{/if}
					</div>
					<div
						class="flex flex-col px-2"
						on:mouseenter={() => (hoveredSection = 'buildings')}
						on:mouseleave={() => (hoveredSection = null)}
					>
						<div class="flex items-center justify-between px-2">
							<h1 class="text-sm font-light text-neutral-400">Properties</h1>
							<button
								class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredSection === 'buildings' || collapsedSections.buildings ? 'opacity-100' : 'opacity-0'}`}
								on:click={() => toggleSection('buildings')}
								type="button"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="14"
									height="14"
									fill="currentColor"
									class={`transition ${collapsedSections.buildings ? '-rotate-90' : ''}`}
									viewBox="0 0 16 16"
								>
									<path
										d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
									/>
								</svg>
							</button>
						</div>
						{#if !collapsedSections.buildings}
							<div class="mt-1 space-y-1">
								<button
									class={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${view === 'building-new' ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
									on:click={handleNewBuilding}
									type="button"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="16"
										height="16"
										fill="#A1A1A1"
										class="bi bi-building-fill-add"
										viewBox="0 0 16 16"
									>
										<path
											d="M12.5 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7m.5-5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0"
										/>
										<path
											d="M2 1a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7.256A4.5 4.5 0 0 0 12.5 8a4.5 4.5 0 0 0-3.59 1.787A.5.5 0 0 0 9 9.5v-1a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .39-.187A4.5 4.5 0 0 0 8.027 12H6.5a.5.5 0 0 0-.5.5V16H3a1 1 0 0 1-1-1zm2 1.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5m3 0v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5m3.5-.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5zM4 5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5M7.5 5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5zm2.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5M4.5 8a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5z"
										/>
									</svg>
									<span class="truncate">New Property</span>
								</button>
								{#each buildings as building}
									<div
										class={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-2 text-left text-sm transition ${building.id === selectedBuildingId && view === 'building' ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
										on:mouseenter={() => (hoveredRow = rowKey('buildings', building.id))}
										on:mouseleave={() => (hoveredRow = null)}
										on:click={() => {
											if (editingRow?.type === 'buildings' && editingRow?.id === building.id)
												return;
											handleBuildingSelect(building.id);
										}}
									>
										{#if editingRow?.type === 'buildings' && editingRow?.id === building.id}
											<div class="flex flex-1 items-center gap-2">
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="14"
													height="14"
													fill="#A1A1A1"
													class="bi bi-building-fill flex-none"
													viewBox="0 0 16 16"
												>
													<path
														d="M3 0a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V16h3a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1zm1 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5M4 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM7.5 5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM4.5 8h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5"
													/>
												</svg>
												<input
													class="w-full bg-transparent p-0 text-sm text-neutral-900 outline-none"
													bind:value={editValue}
													autofocus
													on:keydown={(event) => {
														if (event.key === 'Enter') saveRename();
														if (event.key === 'Escape') cancelRename();
													}}
													on:blur={cancelRename}
													type="text"
												/>
											</div>
										{:else}
											<button class="flex flex-1 items-center gap-2 text-left" type="button">
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="14"
													height="14"
													fill="#A1A1A1"
													class="bi bi-building-fill"
													viewBox="0 0 16 16"
												>
													<path
														d="M3 0a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V16h3a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1zm1 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5M4 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM7.5 5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM4.5 8h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5"
													/>
												</svg>
												<span class="truncate">{building.name}</span>
											</button>
										{/if}
										<div class="relative">
											<button
												class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredRow === rowKey('buildings', building.id) || openRowMenu === rowKey('buildings', building.id) ? 'opacity-100' : 'opacity-0'}`}
												on:click|stopPropagation={() => toggleRowMenu('buildings', building.id)}
												type="button"
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="16"
													height="16"
													fill="currentColor"
													class="bi bi-three-dots"
													viewBox="0 0 16 16"
												>
													<path
														d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3"
													/>
												</svg>
											</button>
											{#if openRowMenu === rowKey('buildings', building.id)}
												<div
													class="absolute right-0 z-[999] mt-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
													on:click|stopPropagation
												>
													<button
														class="flex w-full px-3 py-2 text-left hover:bg-neutral-50"
														on:click={() => startRename('buildings', building.id, building.name)}
														type="button"
													>
														Rename
													</button>
													<button
														class="flex w-full px-3 py-2 text-left text-rose-600 hover:bg-neutral-50"
														on:click={() => deleteRow('buildings', building.id)}
														type="button"
													>
														Delete
													</button>
												</div>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
					<div
						class="flex flex-col px-2"
						on:mouseenter={() => (hoveredSection = 'vendors')}
						on:mouseleave={() => (hoveredSection = null)}
					>
						<div class="flex items-center justify-between px-2">
							<h1 class="text-sm font-light text-neutral-400">Vendors</h1>
							<button
								class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredSection === 'vendors' || collapsedSections.vendors ? 'opacity-100' : 'opacity-0'}`}
								on:click={() => toggleSection('vendors')}
								type="button"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="14"
									height="14"
									fill="currentColor"
									class={`transition ${collapsedSections.vendors ? '-rotate-90' : ''}`}
									viewBox="0 0 16 16"
								>
									<path
										d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
									/>
								</svg>
							</button>
						</div>
						{#if !collapsedSections.vendors}
							<div class="mt-1 space-y-1">
								<button
									class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-neutral-600 transition hover:bg-neutral-100"
									on:click={openNewVendorModal}
									type="button"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="16"
										height="16"
										fill="#A1A1A1"
										class="bi bi-person-fill-add"
										viewBox="0 0 16 16"
									>
										<path
											d="M12.5 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7m.5-5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0m-2-6a3 3 0 1 1-6 0 3 3 0 0 1 6 0"
										/>
										<path
											d="M2 13c0 1 1 1 1 1h5.256A4.5 4.5 0 0 1 8 12.5a4.5 4.5 0 0 1 1.544-3.393Q8.844 9.002 8 9c-5 0-6 3-6 4"
										/>
									</svg>
									<span class="truncate">New Vendor</span>
								</button>
								{#each vendors as vendor}
									<div
										class={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-2 text-left text-sm transition ${vendor.id === selectedVendorId && view === 'vendor' ? 'bg-neutral-200/50 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'}`}
										on:mouseenter={() => (hoveredRow = rowKey('vendors', vendor.id))}
										on:mouseleave={() => (hoveredRow = null)}
										on:click={() => {
											if (editingRow?.type === 'vendors' && editingRow?.id === vendor.id) return;
											handleVendorSelect(vendor.id);
										}}
									>
										{#if editingRow?.type === 'vendors' && editingRow?.id === vendor.id}
											<div class="flex flex-1 items-center gap-2">
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="16"
													height="16"
													fill="#A1A1A1"
													class="bi bi-person-fill flex-none"
													viewBox="0 0 16 16"
												>
													<path
														d="M3 14s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1zm5-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6"
													/>
												</svg>
												<input
													class="w-full bg-transparent p-0 text-sm text-neutral-900 outline-none"
													bind:value={editValue}
													autofocus
													on:keydown={(event) => {
														if (event.key === 'Enter') saveRename();
														if (event.key === 'Escape') cancelRename();
													}}
													on:blur={cancelRename}
													type="text"
												/>
											</div>
										{:else}
											<button class="flex flex-1 items-center gap-2 text-left" type="button">
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="16"
													height="16"
													fill="#A1A1A1"
													class="bi bi-person-fill"
													viewBox="0 0 16 16"
												>
													<path
														d="M3 14s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1zm5-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6"
													/>
												</svg>
												<span class="truncate">{vendor.name}</span>
											</button>
										{/if}
										<div class="relative">
											<button
												class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredRow === rowKey('vendors', vendor.id) || openRowMenu === rowKey('vendors', vendor.id) ? 'opacity-100' : 'opacity-0'}`}
												on:click|stopPropagation={() => toggleRowMenu('vendors', vendor.id)}
												type="button"
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="16"
													height="16"
													fill="currentColor"
													class="bi bi-three-dots"
													viewBox="0 0 16 16"
												>
													<path
														d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3"
													/>
												</svg>
											</button>
											{#if openRowMenu === rowKey('vendors', vendor.id)}
												<div
													class="absolute right-0 bottom-full z-[999] mb-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
													on:click|stopPropagation
												>
													<button
														class="flex w-full px-3 py-2 text-left hover:bg-neutral-50"
														on:click={() => startRename('vendors', vendor.id, vendor.name)}
														type="button"
													>
														Rename
													</button>
													<button
														class="flex w-full px-3 py-2 text-left text-rose-600 hover:bg-neutral-50"
														on:click={() => deleteRow('vendors', vendor.id)}
														type="button"
													>
														Delete
													</button>
												</div>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
				<div class="border-t border-neutral-200 p-2">
					<button
						class="flex w-full flex-row items-center gap-2 rounded-lg px-4 py-3 text-left text-sm hover:bg-neutral-200"
						on:click={() => setView('account')}
						type="button"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="16"
							height="16"
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
						Account
					</button>
				</div>
			</div>
		</aside>

		<section class="flex w-full flex-col overflow-y-auto bg-white md:w-4/5">
			<div class="mx-auto w-full">
				<div
					class="sticky top-0 z-20 flex items-center justify-between border-b border-neutral-100 bg-white/95 px-6 py-4 backdrop-blur"
				>
					<div class="text-sm font-normal text-neutral-800">{sectionTitle}</div>
				</div>
				<div class={`px-8 pb-10 ${view === 'inbox' ? 'pt-2' : 'pt-6'}`}>
					{#if view === 'account'}
						<div class="space-y-6">
							<div class="flex flex-col gap-2">
								<div class="flex items-center justify-between">
									<div class="text-sm font-medium text-neutral-800">Connected emails</div>
									<a
										class="flex flex-row items-center gap-1 rounded-lg px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-200"
										href={connectHref}
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="16"
											height="16"
											fill="currentColor"
											class="bi bi-plus"
											viewBox="0 0 16 16"
										>
											<path
												d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4"
											/>
										</svg>
										Add Account
									</a>
								</div>
								<div class="space-y-3">
									{#each connections as connection}
										<div
											class="flex w-full items-center justify-between rounded-lg border border-neutral-200 bg-white px-4 py-3 text-left text-sm"
										>
											<div class="flex items-center gap-2">
												<svg
													width="18"
													height="18"
													viewBox="0 0 32 32"
													fill="none"
													xmlns="http://www.w3.org/2000/svg"
												>
													<path
														d="M2 11.9556C2 8.47078 2 6.7284 2.67818 5.39739C3.27473 4.22661 4.22661 3.27473 5.39739 2.67818C6.7284 2 8.47078 2 11.9556 2H20.0444C23.5292 2 25.2716 2 26.6026 2.67818C27.7734 3.27473 28.7253 4.22661 29.3218 5.39739C30 6.7284 30 8.47078 30 11.9556V20.0444C30 23.5292 30 25.2716 29.3218 26.6026C28.7253 27.7734 27.7734 28.7253 26.6026 29.3218C25.2716 30 23.5292 30 20.0444 30H11.9556C8.47078 30 6.7284 30 5.39739 29.3218C4.22661 28.7253 3.27473 27.7734 2.67818 26.6026C2 25.2716 2 23.5292 2 20.0444V11.9556Z"
														fill="white"
													/>
													<path
														d="M22.0515 8.52295L16.0644 13.1954L9.94043 8.52295V8.52421L9.94783 8.53053V15.0732L15.9954 19.8466L22.0515 15.2575V8.52295Z"
														fill="#EA4335"
													/>
													<path
														d="M23.6231 7.38639L22.0508 8.52292V15.2575L26.9983 11.459V9.17074C26.9983 9.17074 26.3978 5.90258 23.6231 7.38639Z"
														fill="#FBBC05"
													/>
													<path
														d="M22.0508 15.2575V23.9924H25.8428C25.8428 23.9924 26.9219 23.8813 26.9995 22.6513V11.459L22.0508 15.2575Z"
														fill="#34A853"
													/>
													<path
														d="M9.94811 24.0001V15.0732L9.94043 15.0669L9.94811 24.0001Z"
														fill="#C5221F"
													/>
													<path
														d="M9.94014 8.52404L8.37646 7.39382C5.60179 5.91001 5 9.17692 5 9.17692V11.4651L9.94014 15.0667V8.52404Z"
														fill="#C5221F"
													/>
													<path
														d="M9.94043 8.52441V15.0671L9.94811 15.0734V8.53073L9.94043 8.52441Z"
														fill="#C5221F"
													/>
													<path
														d="M5 11.4668V22.6591C5.07646 23.8904 6.15673 24.0003 6.15673 24.0003H9.94877L9.94014 15.0671L5 11.4668Z"
														fill="#4285F4"
													/>
												</svg>
												<div class="font-medium text-neutral-800">{connection.email}</div>
											</div>
											<div class="flex items-center gap-2">
												<div class="relative">
													<button
														class="inline-flex h-8 items-center gap-2 rounded-lg border border-neutral-200 px-3 text-sm text-neutral-700 transition hover:border-neutral-300 hover:bg-neutral-50"
														on:click={(event) => {
															event.stopPropagation();
															toggleDropdown(connection.id);
														}}
														type="button"
													>
														{modeLabel(connection.mode)}
														<span class="text-neutral-400">▾</span>
													</button>
													{#if openDropdownId === connection.id}
														<div
															class="absolute right-0 z-10 mt-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
														>
															<button
																class="flex w-full px-3 py-2 text-left hover:bg-neutral-50"
																on:click={() => handleModeChange(connection.id, 'read')}
																type="button"
															>
																Read
															</button>
															<button
																class="flex w-full px-3 py-2 text-left hover:bg-neutral-50"
																on:click={() => handleModeChange(connection.id, 'write')}
																type="button"
															>
																Write
															</button>
															<button
																class="flex w-full px-3 py-2 text-left hover:bg-neutral-50"
																on:click={() => handleModeChange(connection.id, 'both')}
																type="button"
															>
																Both
															</button>
														</div>
													{/if}
												</div>
												<button
													class="flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 text-rose-600"
													on:click={(event) => {
														event.stopPropagation();
														handleDisconnect(connection.id);
													}}
													type="button"
												>
													<svg
														xmlns="http://www.w3.org/2000/svg"
														width="16"
														height="16"
														fill="currentColor"
														viewBox="0 0 16 16"
													>
														<path
															d="M11 1.5v1h3.5a.5.5 0 0 1 0 1h-.538l-.853 10.66A2 2 0 0 1 11.115 16h-6.23a2 2 0 0 1-1.994-1.84L2.038 3.5H1.5a.5.5 0 0 1 0-1H5v-1A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5m-5 0v1h4v-1a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5M4.5 5.029l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06m6.53-.528a.5.5 0 0 0-.528.47l-.5 8.5a.5.5 0 0 0 .998.058l.5-8.5a.5.5 0 0 0-.47-.528M8 4.5a.5.5 0 0 0-.5.5v8.5a.5.5 0 0 0 1 0V5a.5.5 0 0 0-.5-.5"
														/>
													</svg>
												</button>
											</div>
										</div>
									{/each}
								</div>
							</div>
							<div class="flex flex-col gap-1">
								{#if workspaceName}
									<div class="mb-1 text-xs text-neutral-400">
										Workspace · <span class="text-neutral-600">{workspaceName}</span>
									</div>
								{/if}
								<div class="text-sm font-medium text-neutral-800">Account</div>
								<div class="flex w-full flex-row gap-4">
									<form class="w-full" on:submit={handleSignOut}>
										<button
											type="submit"
											class="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700"
										>
											Sign out
										</button>
									</form>
									<form class="w-full" on:submit={handleDeleteAccount}>
										<button
											type="submit"
											class="w-full rounded-lg border border-rose-200 px-4 py-2 text-sm text-rose-600"
										>
											Delete account
										</button>
									</form>
								</div>
								<form class="w-full" on:submit={handleResetIssues}>
									<button
										type="submit"
										class="w-full rounded-lg border border-amber-200 px-4 py-2 text-sm text-amber-700"
									>
										Reset all issues
									</button>
								</form>
							</div>
						</div>
					{:else if view === 'inbox'}
						<div class="space-y-4">
							<div>
								{#each actions as action, index}
									<div
										class={`py-5 ${index < actions.length - 1 ? 'border-b border-neutral-100' : ''}`}
									>
										<div class="flex items-start justify-between gap-6">
											<div class="min-w-0 flex-1 space-y-4">
												<div class="flex flex-col">
													<div class="text-sm font-medium text-neutral-900">{action.title}</div>
													{#if action.detail}
														<div class="text-sm leading-relaxed text-neutral-600">
															{action.detail}
														</div>
													{/if}
												</div>
												{#if action.emailBody}
													<div class="rounded-lg bg-neutral-50 px-4 py-3">
														<div class="mb-6">
															<div class="text-sm font-medium text-neutral-900">
																{gmailUser?.name ?? gmailUser?.email ?? 'Bedrock Ops'}
															</div>
															<div class="text-sm text-neutral-500">
																To {action.actionType === 'schedule_vendor'
																	? formatVendorRecipients(action)
																	: action.tenantName && action.tenantEmail
																		? `${action.tenantName} <${action.tenantEmail}>`
																		: (action.tenantEmail ?? action.tenantName ?? 'Tenant')}
															</div>
														</div>
														<textarea
															class="w-full resize-none bg-transparent p-0 text-sm whitespace-pre-line text-neutral-700 focus:outline-none"
															rows={Math.max(3, action.emailBody.split('\n').length)}
															bind:value={action.emailBody}
															on:blur={() => handleActionDraftSave(action)}
														></textarea>
													</div>
												{/if}
												<div class="flex items-center justify-between gap-4 pt-1">
													{#if action.issueId}
														<button
															class="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-stone-100 hover:text-neutral-700"
															on:click={() => handleActionIssueOpen(action.issueId)}
															type="button"
														>
															{#if action.issueUrgency}
																<span
																	class={`h-2 w-2 flex-none rounded-full ${urgencyBuckets.find((bucket) => bucket.key === action.issueUrgency)?.dot ?? 'bg-neutral-300'}`}
																></span>
															{/if}
															<span>{action.issueName}</span>
															{#if action.building || action.unit}
																<span>·</span>
																<span>{action.building ?? 'Unknown'}</span>
																{#if action.unit}
																	<span>{action.unit}</span>
																{/if}
															{/if}
															{#if action.createdAt}
																<span>·</span>
																<span>{formatTimestamp(action.createdAt)}</span>
															{/if}
														</button>
													{:else}
														<div class="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
															{#if action.issueUrgency}
																<span
																	class={`h-2 w-2 flex-none rounded-full ${urgencyBuckets.find((bucket) => bucket.key === action.issueUrgency)?.dot ?? 'bg-neutral-300'}`}
																></span>
															{/if}
															<span>{action.issueName}</span>
															{#if action.building || action.unit}
																<span>·</span>
																<span>{action.building ?? 'Unknown'}</span>
																{#if action.unit}
																	<span>{action.unit}</span>
																{/if}
															{/if}
															{#if action.createdAt}
																<span>·</span>
																<span>{formatTimestamp(action.createdAt)}</span>
															{/if}
														</div>
													{/if}
													<div class="ml-auto flex items-center gap-2">
														<button
															class={`inline-flex items-center justify-center rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 transition-opacity duration-200 ${
																sendingActionIds.has(action.id)
																	? 'opacity-40'
																	: 'hover:bg-neutral-50'
															}`}
															on:click={() =>
																action.issueId && handleActionIssueOpen(action.issueId)}
															type="button"
															disabled={sendingActionIds.has(action.id)}
														>
															Modify
														</button>
														<button
															class={`inline-flex h-9 min-w-[104px] items-center justify-center rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-opacity duration-200 ${
																sendingActionIds.has(action.id)
																	? 'opacity-70'
																	: 'hover:bg-neutral-800'
															}`}
															on:click={() => handleApproveAction(action.id)}
															type="button"
															disabled={sendingActionIds.has(action.id)}
														>
															{#if sendingActionIds.has(action.id)}
																<div
																	class="h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-white"
																></div>
															{:else}
																Approve
															{/if}
														</button>
													</div>
												</div>
											</div>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{:else if view === 'vendor'}
						{#if !selectedVendor}
							<div class="mt-12 text-sm text-neutral-500">Select a vendor to view details.</div>
						{:else}
							<div class="space-y-10">
								<div>
									<div class="text-2xl font-medium text-neutral-800">{selectedVendor.name}</div>
									<div class="mt-1 text-xs text-neutral-500">Vendor profile</div>
								</div>
								<div>
									<div class="text-lg font-semibold text-neutral-800">Contact info</div>
									<div class="mt-4 space-y-4">
										<div>
											<div class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Email</div>
											<input
												class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
												placeholder="andrew@example.com"
												bind:value={vendorEmailDraft}
												type="email"
											/>
										</div>
										<div>
											<div class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Phone</div>
											<input
												class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
												placeholder="(555) 555-1234"
												bind:value={vendorPhoneDraft}
												type="text"
											/>
										</div>
										<div>
											<div class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Trade</div>
											<input
												class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
												placeholder="Plumbing"
												bind:value={vendorTradeDraft}
												type="text"
											/>
										</div>
									</div>
								</div>
								<div>
									<div class="text-lg font-semibold text-neutral-800">Notes</div>
									<textarea
										class="mt-4 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
										rows="5"
										placeholder="Add a note about this vendor"
										bind:value={vendorNoteDraft}
									></textarea>
								</div>
								<div>
									<div class="text-lg font-semibold text-neutral-800">Invoices</div>
									{#if vendorInvoices.length === 0}
										<div class="mt-4 text-sm text-neutral-500">No invoices yet.</div>
									{:else}
										<div class="mt-4 space-y-3">
											{#each vendorInvoices as invoice}
												<div
													class="w-full rounded-lg border border-neutral-200 bg-white px-4 py-3 text-left"
												>
													<div class="flex items-center justify-between">
														<div>
															<div class="text-sm font-semibold text-neutral-800">{invoice.id}</div>
															<div class="mt-1 text-xs text-neutral-500">
																{invoice.property} · {invoice.date}
															</div>
														</div>
														<div class="text-right">
															<div class="text-sm font-bold text-neutral-800">
																${invoice.total.toFixed(2)}
															</div>
															{#if invoiceStatus === 'pending'}
																<div
																	class="mt-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800"
																>
																	Pending Approval
																</div>
															{:else if invoiceStatus === 'approved'}
																<div
																	class="mt-1 inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800"
																>
																	Approved
																</div>
															{/if}
														</div>
													</div>
												</div>
											{/each}
										</div>
									{/if}
								</div>
								{#if selectedVendor && (isSavingVendor || vendorEmailDraft !== (selectedVendor.email ?? '') || vendorPhoneDraft !== (selectedVendor.phone ?? '') || vendorTradeDraft !== (selectedVendor.trade ?? '') || vendorNoteDraft !== (selectedVendor.note ?? ''))}
									<div
										class="fixed bottom-6 left-1/2 z-40 w-[min(720px,90vw)] -translate-x-1/2 rounded-lg border border-neutral-200 bg-white px-5 py-3 shadow-lg"
										transition:fly={{ y: 16, duration: 180 }}
									>
										<div class="flex items-center justify-between">
											<div class="text-sm font-medium text-neutral-800">
												Careful — you have unsaved changes!
											</div>
											<div class="flex items-center gap-3">
												<button
													class="rounded-lg px-3 py-2 text-sm font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
													on:click={resetVendorDrafts}
													type="button"
												>
													Reset
												</button>
												<button
													class={`inline-flex w-30 items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${isSavingVendor ? 'bg-emerald-600 text-white' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
													on:click={handleSaveVendorDetails}
													disabled={isSavingVendor}
													type="button"
												>
													{#if isSavingVendor}
														<span
															class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
														></span>
														Saving...
													{:else}
														Save Changes
													{/if}
												</button>
											</div>
										</div>
									</div>
								{/if}
							</div>
						{/if}
					{:else if view === 'building'}
						{#if !selectedBuilding}
							<div class="mt-12 text-sm text-neutral-500">Select a building to view details.</div>
						{:else}
							<div class="space-y-6">
								<div class="flex items-center justify-between">
									<div>
										<div class="text-2xl font-medium text-neutral-800">{selectedBuilding.name}</div>
									</div>
								</div>
								<div class="rounded-lg bg-white">
									<div class="flex items-center justify-between">
										<div class="text-sm font-medium text-neutral-800">Units</div>
										<button
											class="rounded-md px-2 py-1 text-xs text-neutral-700 transition hover:bg-neutral-100"
											on:click={openNewUnitModal}
											type="button"
										>
											Add Unit
										</button>
									</div>
									<div class="mt-4 space-y-3">
										{#each units.filter((unit) => unit.building_id === selectedBuilding.id) as unit}
											{@const unitTenants = tenants.filter((tenant) => tenant.unit_id === unit.id)}
											<div class="rounded-lg border border-neutral-100 bg-neutral-50">
												<div
													class="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-sm text-neutral-700"
													on:click={() => toggleUnit(unit.id)}
													role="button"
													tabindex="0"
													on:keydown={(e) => {
														if (e.key === 'Enter' || e.key === ' ') toggleUnit(unit.id);
													}}
												>
													<span class="flex-1 font-medium">
														{unit.name}
														{#if unitTenants.length > 0}
															<span class="font-normal text-neutral-500">
																- {unitTenants.map((t) => t.name).join(', ')}</span
															>
														{/if}
													</span>
													<span class="flex items-center gap-3">
														<button
															class="text-xs text-neutral-500 transition hover:text-neutral-700"
															on:click={(e) => {
																e.stopPropagation();
																openNewTenantModal(unit.id);
															}}
															type="button"
														>
															Add Tenant
														</button>
														<span class="text-neutral-400">
															<svg
																xmlns="http://www.w3.org/2000/svg"
																width="14"
																height="14"
																fill="currentColor"
																class={`transition ${expandedUnitIds.has(unit.id) ? 'rotate-180' : ''}`}
																viewBox="0 0 16 16"
															>
																<path
																	d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
																/>
															</svg>
														</span>
													</span>
												</div>
												{#if expandedUnitIds.has(unit.id)}
													<div class="border-t border-neutral-100 bg-white px-4 py-3">
														{#if !tenants.filter((tenant) => tenant.unit_id === unit.id).length}
															<div class="mt-2 text-xs text-neutral-500">No tenants yet.</div>
														{:else}
															<div class="mt-2 space-y-2">
																{#each tenants.filter((tenant) => tenant.unit_id === unit.id) as tenant}
																	<div
																		class="flex items-center justify-between text-sm text-neutral-600"
																		on:mouseenter={() =>
																			(hoveredRow = rowKey('tenants', tenant.id))}
																		on:mouseleave={() => (hoveredRow = null)}
																	>
																		<div class="min-w-0">
																			{tenant.name}
																			<span class="text-xs text-neutral-400">· {tenant.email}</span>
																		</div>
																		<div class="relative">
																			<button
																				class={`rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 ${hoveredRow === rowKey('tenants', tenant.id) || openRowMenu === rowKey('tenants', tenant.id) ? 'opacity-100' : 'opacity-0'}`}
																				on:click|stopPropagation={() =>
																					toggleRowMenu('tenants', tenant.id)}
																				type="button"
																			>
																				<svg
																					xmlns="http://www.w3.org/2000/svg"
																					width="16"
																					height="16"
																					fill="currentColor"
																					class="bi bi-three-dots"
																					viewBox="0 0 16 16"
																				>
																					<path
																						d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3"
																					/>
																				</svg>
																			</button>
																			{#if openRowMenu === rowKey('tenants', tenant.id)}
																				<div
																					class="absolute right-0 z-[999] mt-2 w-28 rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-sm"
																					on:click|stopPropagation
																				>
																					<button
																						class="flex w-full px-3 py-2 text-left hover:bg-neutral-50"
																						on:click={() => openEditTenantModal(tenant)}
																						type="button"
																					>
																						Edit
																					</button>
																					<button
																						class="flex w-full px-3 py-2 text-left text-rose-600 hover:bg-neutral-50"
																						on:click={() => deleteRow('tenants', tenant.id)}
																						type="button"
																					>
																						Delete
																					</button>
																				</div>
																			{/if}
																		</div>
																	</div>
																{/each}
															</div>
														{/if}
													</div>
												{/if}
											</div>
										{/each}
									</div>
								</div>
							</div>
						{/if}
					{:else if !selectedIssue}
						<div class="mt-12 text-sm text-neutral-500">Select an issue to view details.</div>
					{:else}
						<div class="flex flex-row justify-between gap-4">
							<div class="flex items-center gap-3">
								<div class="text-2xl font-medium text-neutral-700">{selectedIssue.name}</div>
								<div class="flex flex-row gap-1">
									<div class="text-2xl font-medium text-neutral-500">{selectedIssue.building}</div>
									<div class="text-2xl font-medium text-neutral-500">{selectedIssue.unit}</div>
								</div>
							</div>
							<div
								class={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold ${statusStyles[selectedIssue.status] || ''}`}
							>
								{titleCaseWords(selectedIssue.status)}
							</div>
						</div>
						<p class="mt-2 text-base leading-relaxed text-neutral-700">
							{selectedIssue.description || 'Summary pending.'}
						</p>

						{#if hasInvoice}
							<div class="mt-6">
								<div class="text-[11px] tracking-[0.2em] text-neutral-400 uppercase">Invoice</div>
								<div
									class="mt-3 w-full rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left"
								>
									<div class="flex items-center justify-between">
										<div class="flex items-center gap-3">
											<div
												class="flex h-8 w-8 items-center justify-center rounded-full bg-amber-500"
											>
												<svg
													xmlns="http://www.w3.org/2000/svg"
													width="16"
													height="16"
													fill="white"
													viewBox="0 0 16 16"
												>
													<path
														d="M14 3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM2 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"
													/>
													<path
														d="M2 5.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5zm0 3a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0 2a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 0 1h-1a.5.5 0 0 1-.5-.5m3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 0 1h-1a.5.5 0 0 1-.5-.5m3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 0 1h-1a.5.5 0 0 1-.5-.5m3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 0 1h-1a.5.5 0 0 1-.5-.5"
													/>
												</svg>
											</div>
											<div>
												<div class="text-sm font-semibold text-amber-900">
													{mockInvoice.id} — Pending Approval
												</div>
												<div class="mt-1 text-xs text-amber-700">
													{mockInvoice.vendor.name} · ${mockInvoice.total.toFixed(2)}
												</div>
											</div>
										</div>
										<span class="inline-flex items-center gap-1 text-xs text-amber-700">
											Review Invoice
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="12"
												height="12"
												fill="currentColor"
												viewBox="0 0 16 16"
											>
												<path
													d="M1 8a.5.5 0 0 1 .5-.5h10.793L9.146 4.354a.5.5 0 1 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L12.293 8.5H1.5A.5.5 0 0 1 1 8"
												/>
											</svg>
										</span>
									</div>
								</div>
							</div>
						{/if}

						<div class="mt-6">
							<div
								class={`grid gap-6 ${assignedVendorName || vendorInlineActions.length ? 'lg:grid-cols-2' : 'grid-cols-1'}`}
							>
								<div class="space-y-3">
									{#if tenantThreadMessages.length || !tenantInlineActions.length}
										<MessageThread messages={tenantThreadMessages} tenant={selectedTenant} />
									{/if}
									{#if tenantInlineActions.length}
										{#each tenantInlineActions as action (action.id)}
											{@const recipient = inlineActionRecipient(action, 'tenant')}
											<div class="rounded-lg border border-dashed border-neutral-200 bg-white">
												<div class="px-5 py-4">
													<div class="flex items-start justify-between gap-4">
														<div class="min-w-0">
															<div class="text-sm font-medium text-neutral-900">
																{inlineActionFromLabel()}
															</div>
															<div class="mt-1 text-sm text-neutral-500">
																To {recipient.toName}{recipient.toEmail
																	? ` <${recipient.toEmail}>`
																	: ''}
															</div>
														</div>
														<button
															class={`inline-flex h-9 items-center justify-center rounded-lg bg-neutral-900 px-4 text-sm font-semibold text-white transition-opacity ${
																sendingActionIds.has(action.id)
																	? 'opacity-70'
																	: 'hover:bg-neutral-800'
															}`}
															on:click={() => handleApproveAction(action.id)}
															type="button"
															disabled={sendingActionIds.has(action.id)}
														>
															{#if sendingActionIds.has(action.id)}
																<div
																	class="h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-white"
																></div>
															{:else}
																Send
															{/if}
														</button>
													</div>
													<div class="mt-4">
														<textarea
															class="w-full resize-none bg-transparent p-0 text-sm whitespace-pre-line text-neutral-800 focus:outline-none"
															rows={Math.max(6, action.emailBody?.split('\n').length ?? 6)}
															bind:value={action.emailBody}
															on:blur={() => handleActionDraftSave(action)}
														></textarea>
													</div>
												</div>
											</div>
										{/each}
									{/if}
								</div>
								{#if assignedVendorName || suggestedVendorRecipients.length || vendorInlineActions.length}
									<div class="space-y-3">
										{#if assignedVendor}
											<button
												class="w-full rounded-lg border border-neutral-100 bg-stone-100 px-4 py-3 text-left transition hover:border-neutral-200"
												on:click={() => handleVendorSelect(assignedVendor.id)}
												type="button"
											>
												<div class="flex items-center justify-between">
													<div class="text-sm font-semibold text-neutral-800">
														{assignedVendorName}
													</div>
													<span class="inline-flex items-center gap-1 text-xs text-neutral-400">
														View Vendor
														<svg
															xmlns="http://www.w3.org/2000/svg"
															width="12"
															height="12"
															fill="currentColor"
															viewBox="0 0 16 16"
														>
															<path
																d="M1 8a.5.5 0 0 1 .5-.5h10.793L9.146 4.354a.5.5 0 1 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L12.293 8.5H1.5A.5.5 0 0 1 1 8"
															/>
														</svg>
													</span>
												</div>
												{#if assignedVendor.trade || assignedVendor.email || assignedVendor.phone}
													<div class="mt-1 text-xs text-neutral-500">
														{assignedVendor.trade ?? ''}
														{#if assignedVendor.trade && (assignedVendor.email || assignedVendor.phone)}
															<span> · </span>
														{/if}
														{assignedVendor.email ?? ''}
														{#if assignedVendor.email && assignedVendor.phone}
															<span> · </span>
														{/if}
														{assignedVendor.phone ?? ''}
													</div>
												{/if}
											</button>
										{/if}
										{#if suggestedVendorRecipients.length}
											{#each suggestedVendorRecipients as vendor}
												{#if vendor.id}
													<button
														class="w-full rounded-lg border border-neutral-100 bg-stone-100 px-4 py-3 text-left transition hover:border-neutral-200"
														on:click={() => handleVendorSelect(vendor.id)}
														type="button"
													>
														<div class="flex items-center justify-between">
															<div class="text-sm font-semibold text-neutral-800">
																{vendor.name ?? vendor.email}
															</div>
															<span class="inline-flex items-center gap-1 text-xs text-neutral-400">
																View Vendor
																<svg
																	xmlns="http://www.w3.org/2000/svg"
																	width="12"
																	height="12"
																	fill="currentColor"
																	viewBox="0 0 16 16"
																>
																	<path
																		d="M1 8a.5.5 0 0 1 .5-.5h10.793L9.146 4.354a.5.5 0 1 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L12.293 8.5H1.5A.5.5 0 0 1 1 8"
																	/>
																</svg>
															</span>
														</div>
														{#if vendor.trade || vendor.email || vendor.phone}
															<div class="mt-1 text-xs text-neutral-500">
																{vendor.trade ?? ''}
																{#if vendor.trade && (vendor.email || vendor.phone)}
																	<span> · </span>
																{/if}
																{vendor.email ?? ''}
																{#if vendor.email && vendor.phone}
																	<span> · </span>
																{/if}
																{vendor.phone ?? ''}
															</div>
														{/if}
													</button>
												{:else}
													<div class="rounded-lg border border-neutral-100 bg-stone-100 px-4 py-3">
														<div class="text-sm font-semibold text-neutral-800">
															{vendor.name ?? vendor.email}
														</div>
														{#if vendor.name}
															<div class="mt-1 text-xs text-neutral-500">{vendor.email}</div>
														{/if}
													</div>
												{/if}
											{/each}
										{/if}
										{#if vendorThreadMessages.length || !vendorInlineActions.length}
											<MessageThread
												messages={vendorThreadMessages}
												tenant={assignedVendorContact ?? { name: 'Vendor', email: '' }}
											/>
										{/if}
										{#if vendorInlineActions.length}
											{#each vendorInlineActions as action (action.id)}
												{@const recipient = inlineActionRecipient(action, 'vendor')}
												<div class="rounded-lg border border-dashed border-neutral-200 bg-white">
													<div class="px-5 py-4">
														<div class="flex items-start justify-between gap-4">
															<div class="min-w-0">
																<div class="text-sm font-medium text-neutral-900">
																	{inlineActionFromLabel()}
																</div>
																<div class="mt-1 text-sm text-neutral-500">
																	To {recipient.toName}{recipient.toEmail
																		? ` <${recipient.toEmail}>`
																		: ''}
																</div>
															</div>
															<button
																class={`inline-flex h-9 items-center justify-center rounded-lg bg-neutral-900 px-4 text-sm font-semibold text-white transition-opacity ${
																	sendingActionIds.has(action.id)
																		? 'opacity-70'
																		: 'hover:bg-neutral-800'
																}`}
																on:click={() => handleApproveAction(action.id)}
																type="button"
																disabled={sendingActionIds.has(action.id)}
															>
																{#if sendingActionIds.has(action.id)}
																	<div
																		class="h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-white"
																	></div>
																{:else}
																	Send
																{/if}
															</button>
														</div>
														<div class="mt-4">
															<textarea
																class="w-full resize-none bg-transparent p-0 text-sm whitespace-pre-line text-neutral-800 focus:outline-none"
																rows={Math.max(6, action.emailBody?.split('\n').length ?? 6)}
																bind:value={action.emailBody}
																on:blur={() => handleActionDraftSave(action)}
															></textarea>
														</div>
													</div>
												</div>
											{/each}
										{/if}
									</div>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			</div>
		</section>
	</div>
</div>

{#if showNewBuildingModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/10 backdrop-blur-[2px]"
		in:fade={{ duration: 80 }}
		on:click={closeNewBuildingModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-xl rounded-2xl border border-neutral-200 bg-white p-6 py-4 shadow-xl"
			in:fade={{ duration: 0 }}
			out:fade={{ duration: 0 }}
		>
			<div class="flex items-center justify-between">
				<div class="text-lg font-medium text-neutral-800">Create building</div>
				<button
					class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
					on:click={closeNewBuildingModal}
					type="button"
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
			<div class="mt-4 space-y-4">
				<div>
					<input
						class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
						placeholder="Peach's Castle"
						bind:value={newBuildingName}
						type="text"
					/>
				</div>
			</div>
			<div class="mt-6 flex items-center justify-between">
				<p class="text-xs text-neutral-500">Buildings keep units, tenants, and issues organized.</p>
				<button
					class={`rounded-full px-4 py-2 text-sm font-medium transition ${newBuildingName.trim() ? 'bg-neutral-900 text-white hover:bg-neutral-800' : 'bg-neutral-200 text-neutral-500'}`}
					disabled={!newBuildingName.trim()}
					on:click={handleCreateBuilding}
					type="button"
				>
					Create building
				</button>
			</div>
		</div>
	</div>
{/if}

{#if showNewUnitModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/10 backdrop-blur-[2px]"
		in:fade={{ duration: 80 }}
		on:click={closeNewUnitModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			in:fade={{ duration: 0 }}
			out:fade={{ duration: 0 }}
		>
			<div class="flex items-center justify-between">
				<div class="text-base font-semibold text-neutral-800">Create unit</div>
				<button
					class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
					on:click={closeNewUnitModal}
					type="button"
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
			<div class="mt-4 space-y-4">
				<div>
					<input
						class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
						placeholder="123"
						bind:value={newUnitName}
						type="text"
					/>
				</div>
			</div>
			<div class="mt-6 flex items-center justify-between">
				<p class="text-xs text-neutral-500">Units group tenants for a building.</p>
				<button
					class={`rounded-full px-4 py-2 text-sm font-medium transition ${newUnitName.trim() ? 'bg-neutral-900 text-white hover:bg-neutral-800' : 'bg-neutral-200 text-neutral-500'}`}
					disabled={!newUnitName.trim()}
					on:click={handleCreateUnit}
					type="button"
				>
					Create unit
				</button>
			</div>
		</div>
	</div>
{/if}

{#if showNewTenantModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/10 backdrop-blur-[2px]"
		in:fade={{ duration: 80 }}
		on:click={closeNewTenantModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			in:fade={{ duration: 0 }}
			out:fade={{ duration: 0 }}
		>
			<div class="flex items-center justify-between">
				<div class="text-base font-semibold text-neutral-800">
					{isEditingTenant ? 'Edit tenant' : 'Create tenant'}
				</div>
				<button
					class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
					on:click={closeNewTenantModal}
					type="button"
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
			<div class="mt-4 space-y-4">
				<div>
					<label class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Tenant name</label>
					<input
						class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
						placeholder="Andrew"
						bind:value={newTenantName}
						type="text"
					/>
				</div>
				<div>
					<label class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Tenant email</label>
					<input
						class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
						placeholder="andrew@example.com"
						bind:value={newTenantEmail}
						type="email"
					/>
				</div>
			</div>
			<div class="mt-6 flex items-center justify-between">
				<p class="text-xs text-neutral-500">
					{isEditingTenant ? 'Update the tenant profile.' : 'Tenants receive maintenance updates.'}
				</p>
				<button
					class={`rounded-full px-4 py-2 text-sm font-medium transition ${newTenantName.trim() && newTenantEmail.trim() ? 'bg-neutral-900 text-white hover:bg-neutral-800' : 'bg-neutral-200 text-neutral-500'}`}
					disabled={!newTenantName.trim() || !newTenantEmail.trim()}
					on:click={handleCreateTenant}
					type="button"
				>
					{isEditingTenant ? 'Update tenant' : 'Create tenant'}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if showNewVendorModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/10 backdrop-blur-[2px]"
		in:fade={{ duration: 80 }}
		on:click={closeNewVendorModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class="pointer-events-auto w-full max-w-xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			in:fade={{ duration: 0 }}
			out:fade={{ duration: 0 }}
		>
			<div class="flex items-center justify-between">
				<div class="text-base font-semibold text-neutral-800">Create vendor</div>
				<button
					class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
					on:click={closeNewVendorModal}
					type="button"
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
			<div class="mt-4 space-y-4">
				<div>
					<label class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Vendor name</label>
					<input
						class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
						placeholder="Andrew"
						bind:value={newVendorName}
						type="text"
					/>
				</div>
				<div>
					<label class="text-xs tracking-[0.2em] text-neutral-400 uppercase"
						>Vendor email (optional)</label
					>
					<input
						class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
						placeholder="andrew@example.com"
						bind:value={newVendorEmail}
						type="email"
					/>
				</div>
			</div>
			<div class="mt-6 flex items-center justify-between">
				<p class="text-xs text-neutral-500">Vendors receive work orders.</p>
				<button
					class={`rounded-full px-4 py-2 text-sm font-medium transition ${newVendorName.trim() ? 'bg-neutral-900 text-white hover:bg-neutral-800' : 'bg-neutral-200 text-neutral-500'}`}
					disabled={!newVendorName.trim()}
					on:click={handleCreateVendor}
					type="button"
				>
					Create vendor
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(body) {
		background: #ffffff;
	}

	:global(*) {
		box-sizing: border-box;
	}
</style>
