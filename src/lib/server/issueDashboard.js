// @ts-nocheck
import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { ensureWorkspace, getWorkspaceForUser } from '$lib/server/workspaces';

const getGmailUser = async (supabase, user) => {
	if (!user) {
		return { connected: false, name: 'Connect Gmail', email: null };
	}
	const { data: sendConnection } = await supabase
		.from('gmail_connections')
		.select('email, mode, updated_at')
		.eq('user_id', user.id)
		.in('mode', ['write', 'both'])
		.order('updated_at', { ascending: false })
		.limit(1)
		.maybeSingle();
	if (sendConnection?.email) {
		return { connected: true, name: sendConnection.email, email: sendConnection.email };
	}
	const { data: anyConnection } = await supabase
		.from('gmail_connections')
		.select('email, updated_at')
		.eq('user_id', user.id)
		.order('updated_at', { ascending: false })
		.limit(1)
		.maybeSingle();
	if (anyConnection?.email) {
		return { connected: true, name: anyConnection.email, email: anyConnection.email };
	}
	return { connected: false, name: 'Connect Gmail', email: null };
};

const resolveWorkspace = async ({ locals, params }) => {
	if (!locals.user) return null;
	await ensureWorkspace(locals.supabase, locals.user);
	const requestedSlug = params?.workspace ?? null;
	if (requestedSlug) {
		const selected = await getWorkspaceForUser(locals.supabase, locals.user, requestedSlug);
		if (!selected || selected.slug !== requestedSlug) {
			const fallback = await getWorkspaceForUser(locals.supabase, locals.user);
			if (fallback?.slug) {
				throw redirect(303, `/${fallback.slug}`);
			}
			return null;
		}
		return selected;
	}
	return await getWorkspaceForUser(locals.supabase, locals.user);
};

const getWorkspaceRedirect = async ({ locals, params, user }) => {
	if (!user) return '/agentmvp';
	await ensureWorkspace(locals.supabase, user);
	const { supabaseAdmin } = await import('$lib/supabaseAdmin');
	const { data: adminWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('slug')
		.eq('admin_user_id', user.id)
		.maybeSingle();
	if (adminWorkspace?.slug) {
		return `/${adminWorkspace.slug}`;
	}
	const workspace = await getWorkspaceForUser(locals.supabase, user, params?.workspace ?? null);
	if (workspace?.slug) {
		return `/${workspace.slug}`;
	}
	const fallback = await getWorkspaceForUser(locals.supabase, user);
	if (fallback?.slug) {
		return `/${fallback.slug}`;
	}
	return '/agentmvp';
};

export const load = async ({ locals, params }) => {
	const gmailUser = await getGmailUser(locals.supabase, locals.user);
	const { data: sessionData } = await locals.supabase.auth.getSession();
	const realtimeAccessToken = sessionData?.session?.access_token ?? null;
	if (!locals.user) {
		return {
			user: null,
			gmailUser,
			issues: [],
			threadsByIssue: {},
			messagesByThread: {},
			connections: [],
			buildings: [],
			vendors: [],
			actions: []
		};
	}

	const workspace = await resolveWorkspace({ locals, params });
	const workspaceId = workspace?.id ?? null;
	if (!workspaceId) {
		return {
			user: locals.user,
			gmailUser,
			realtimeAccessToken,
			issues: [],
			threadsByIssue: {},
			messagesByThread: {},
			connections: [],
			buildings: [],
			vendors: [],
			units: [],
			tenants: [],
			actions: []
		};
	}

	const { data: connections } = await locals.supabase
		.from('gmail_connections')
		.select('id, email, mode')
		.order('updated_at', { ascending: false });

	const { data: sidebarBuildings } = await locals.supabase
		.from('properties')
		.select('id, name')
		.eq('workspace_id', workspaceId)
		.order('name', { ascending: true });
	const { data: sidebarVendors, error: sidebarVendorsError } = await locals.supabase
		.from('vendors')
		.select('id, name, email, phone, trade, note')
		.eq('workspace_id', workspaceId)
		.order('name', { ascending: true });
	const { data: sidebarVendorsFallback } = sidebarVendorsError
		? await locals.supabase
				.from('vendors')
				.select('id, name, email, phone, trade')
				.eq('workspace_id', workspaceId)
				.order('name', { ascending: true })
		: { data: null };
	const vendorsData = sidebarVendorsError ? sidebarVendorsFallback : sidebarVendors;
	const sidebarBuildingIds = (sidebarBuildings ?? []).map((building) => building.id);

	const { data: actions } = await locals.supabase
		.from('tasks')
		.select(
			'id, issue_id, action_type, title, detail, email_body, vendor_email_to, status, created_at'
		)
		.eq('status', 'pending')
		.eq('workspace_id', workspaceId)
		.order('created_at', { ascending: false });

	const { data: issues } = await locals.supabase
		.from('issues')
		.select(
			'id, name, urgency, status, description, vendor_id, suggested_vendor_id, unit_id, tenant_id'
		)
		.eq('workspace_id', workspaceId)
		.order('updated_at', { ascending: false });

	const unitIds = Array.from(new Set((issues ?? []).map((issue) => issue.unit_id).filter(Boolean)));
	const vendorIds = Array.from(
		new Set(
			(issues ?? [])
				.flatMap((issue) => [issue.vendor_id, issue.suggested_vendor_id])
				.filter(Boolean)
		)
	);

	const { data: units } = unitIds.length
		? await locals.supabase.from('units').select('id, name, property_id').in('id', unitIds)
		: { data: [] };
	const normalizedUnits = (units ?? []).map((unit) => ({
		...unit,
		building_id: unit.property_id
	}));

	const buildingIds = Array.from(
		new Set((normalizedUnits ?? []).map((unit) => unit.building_id).filter(Boolean))
	);

	const { data: buildings } = buildingIds.length
		? await locals.supabase.from('properties').select('id, name').in('id', buildingIds)
		: { data: [] };

	const { data: allUnits } = sidebarBuildingIds.length
		? await locals.supabase
				.from('units')
				.select('id, name, property_id')
				.in('property_id', sidebarBuildingIds)
				.order('name', { ascending: true })
		: { data: [] };
	const normalizedAllUnits = (allUnits ?? []).map((unit) => ({
		...unit,
		building_id: unit.property_id
	}));

	const unitIdsForTenants = (normalizedAllUnits ?? []).map((unit) => unit.id);
	const { data: allTenants } = unitIdsForTenants.length
		? await locals.supabase
				.from('tenants')
				.select('id, name, email, unit_id')
				.in('unit_id', unitIdsForTenants)
				.order('name', { ascending: true })
		: { data: [] };

	const { data: vendors } = vendorIds.length
		? await locals.supabase.from('vendors').select('id, name, email').in('id', vendorIds)
		: { data: [] };

	const unitMap = new Map((normalizedUnits ?? []).map((unit) => [unit.id, unit]));
	const buildingMap = new Map((buildings ?? []).map((building) => [building.id, building]));
	const vendorMap = new Map((vendors ?? []).map((vendor) => [vendor.id, vendor]));
	const tenantMap = new Map((allTenants ?? []).map((tenant) => [tenant.id, tenant]));

	const normalizedIssues = (issues ?? []).map((issue) => {
		const unit = unitMap.get(issue.unit_id);
		const building = unit ? buildingMap.get(unit.building_id) : null;
		return {
			id: issue.id,
			name: issue.name,
			urgency: issue.urgency,
			status: issue.status,
			description: issue.description,
			vendorId: issue.vendor_id ?? null,
			suggestedVendorId: issue.suggested_vendor_id ?? null,
			unitId: issue.unit_id ?? null,
			tenantId: issue.tenant_id ?? null,
			unit: unit?.name ?? 'Unknown',
			building: building?.name ?? 'Unknown',
			vendorName: issue.vendor_id ? (vendorMap.get(issue.vendor_id)?.name ?? null) : null,
			vendorEmail: issue.vendor_id ? (vendorMap.get(issue.vendor_id)?.email ?? null) : null,
			suggestedVendorName: issue.suggested_vendor_id
				? (vendorMap.get(issue.suggested_vendor_id)?.name ?? null)
				: null,
			suggestedVendorEmail: issue.suggested_vendor_id
				? (vendorMap.get(issue.suggested_vendor_id)?.email ?? null)
				: null,
			tenantName: issue.tenant_id ? (tenantMap.get(issue.tenant_id)?.name ?? null) : null,
			tenantEmail: issue.tenant_id ? (tenantMap.get(issue.tenant_id)?.email ?? null) : null
		};
	});

	const issueMap = new Map(normalizedIssues.map((issue) => [issue.id, issue]));
	const normalizedActions = (actions ?? []).map((action) => {
		const issue = action.issue_id ? issueMap.get(action.issue_id) : null;
		return {
			id: action.id,
			issueId: action.issue_id ?? null,
			actionType: action.action_type ?? 'triage_issue',
			title: action.title,
			detail: action.detail,
			emailBody: action.email_body ?? '',
			vendorEmailTo: action.vendor_email_to ?? null,
			status: action.status,
			createdAt: action.created_at,
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
	});

	const issueIds = normalizedIssues.map((issue) => issue.id);
	if (!issueIds.length) {
		return {
			user: locals.user,
			gmailUser,
			realtimeAccessToken,
			issues: normalizedIssues,
			threadsByIssue: {},
			messagesByThread: {},
			connections: connections ?? [],
			buildings: sidebarBuildings ?? [],
			vendors: vendorsData ?? [],
			units: normalizedAllUnits ?? [],
			tenants: allTenants ?? [],
			actions: normalizedActions,
			workspace
		};
	}

	const { data: threads } = await locals.supabase
		.from('threads')
		.select('id, issue_id, participant_type')
		.in('issue_id', issueIds)
		.eq('workspace_id', workspaceId);

	const threadIds = (threads ?? []).map((thread) => thread.id);
	if (!threadIds.length) {
		return {
			user: locals.user,
			gmailUser,
			realtimeAccessToken,
			issues: normalizedIssues,
			threadsByIssue: {},
			messagesByThread: {},
			connections: connections ?? [],
			buildings: sidebarBuildings ?? [],
			vendors: vendorsData ?? [],
			units: normalizedAllUnits ?? [],
			tenants: allTenants ?? [],
			actions: normalizedActions,
			workspace
		};
	}

	const { data: messages } = await locals.supabase
		.from('messages')
		.select(
			'id, thread_id, message, sender, subject, timestamp, direction, delivery_status, channel'
		)
		.in('thread_id', threadIds)
		.order('timestamp', { ascending: true });

	const messagesByThread = {};
	const latestByThread = {};
	for (const message of messages ?? []) {
		if (!messagesByThread[message.thread_id]) {
			messagesByThread[message.thread_id] = [];
		}
		messagesByThread[message.thread_id].push(message);
		const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : 0;
		if (!latestByThread[message.thread_id] || timestamp > latestByThread[message.thread_id]) {
			latestByThread[message.thread_id] = timestamp;
		}
	}

	const threadsByIssue = {};
	const groupedThreads = {};
	for (const thread of threads ?? []) {
		const issueId = thread.issue_id;
		if (!groupedThreads[issueId]) {
			groupedThreads[issueId] = { tenant: [], vendor: [] };
		}
		if (thread.participant_type === 'vendor') {
			groupedThreads[issueId].vendor.push(thread.id);
		} else {
			groupedThreads[issueId].tenant.push(thread.id);
		}
	}

	const pickLatestThread = (threadIds) => {
		let selectedThread = threadIds[0] ?? null;
		let latestTimestamp = 0;
		for (const threadId of threadIds) {
			const timestamp = latestByThread[threadId] ?? 0;
			if (timestamp >= latestTimestamp) {
				latestTimestamp = timestamp;
				selectedThread = threadId;
			}
		}
		return selectedThread;
	};

	for (const issueId of issueIds) {
		const issueThreads = groupedThreads[issueId] ?? { tenant: [], vendor: [] };
		threadsByIssue[issueId] = {
			tenant: pickLatestThread(issueThreads.tenant),
			vendor: pickLatestThread(issueThreads.vendor)
		};
	}

	return {
		user: locals.user,
		gmailUser,
		realtimeAccessToken,
		issues: normalizedIssues,
		threadsByIssue,
		messagesByThread,
		connections: connections ?? [],
		buildings: sidebarBuildings ?? [],
		vendors: vendorsData ?? [],
		units: normalizedAllUnits ?? [],
		tenants: allTenants ?? [],
		actions: normalizedActions,
		workspace
	};
};

export const actions = {
	signIn: async ({ request, locals, params }) => {
		const form = await request.formData();
		const email = form.get('email');
		const password = form.get('password');

		if (!email || !password) {
			return fail(400, { error: 'Email and password are required.' });
		}

		const { data: signInData, error: signInError } = await locals.supabase.auth.signInWithPassword({
			email,
			password
		});

		if (signInError) {
			if (signInError.message.toLowerCase().includes('invalid login credentials')) {
				const { data: signUpData, error: signUpError } = await locals.supabase.auth.signUp({
					email,
					password
				});
				if (signUpError) {
					return fail(400, { error: signUpError.message });
				}
				await ensureWorkspace(locals.supabase, signUpData.user);
				throw redirect(303, await getWorkspaceRedirect({ locals, params, user: signUpData.user }));
			}

			return fail(400, { error: signInError.message });
		}

		await ensureWorkspace(locals.supabase, signInData.user);
		throw redirect(303, await getWorkspaceRedirect({ locals, params, user: signInData.user }));
	},
	signOut: async ({ locals, params }) => {
		await locals.supabase.auth.signOut();
		const redirectTarget = params?.workspace ? `/${params.workspace}` : '/agentmvp';
		throw redirect(303, redirectTarget);
	},

	deleteAccount: async ({ locals, params }) => {
		const user = locals.user;
		if (!user) {
			throw redirect(303, params?.workspace ? `/${params.workspace}` : '/agentmvp');
		}
		const { supabaseAdmin } = await import('$lib/supabaseAdmin');
		const deleteData = async (table) => {
			await locals.supabase.from(table).delete().eq('user_id', user.id);
		};

		const { data: connections } = await locals.supabase
			.from('gmail_connections')
			.select('id, email, access_token, refresh_token, expires_at')
			.eq('user_id', user.id);

		for (const connection of connections ?? []) {
			try {
				const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/stop', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${connection.access_token}`
					}
				});
				if (!response.ok && connection.refresh_token) {
					const body = new URLSearchParams({
						client_id: process.env.GOOGLE_CLIENT_ID ?? '',
						client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
						refresh_token: connection.refresh_token,
						grant_type: 'refresh_token'
					});
					const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
						method: 'POST',
						headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
						body
					});
					if (refreshResponse.ok) {
						const refreshed = await refreshResponse.json();
						await fetch('https://gmail.googleapis.com/gmail/v1/users/me/stop', {
							method: 'POST',
							headers: {
								Authorization: `Bearer ${refreshed.access_token}`
							}
						});
					}
				}
			} catch {
				// best effort
			}
		}

		await deleteData('gmail_connections');
		await deleteData('email_ingestion_state');
		await deleteData('ingestion_errors');

		await locals.supabase.from('users').delete().eq('id', user.id);
		try {
			await supabaseAdmin.auth.admin.deleteUser(user.id);
		} catch {
			// best effort
		}
		throw redirect(303, params?.workspace ? `/${params.workspace}` : '/agentmvp');
	},
	updateConnection: async ({ request, locals, params }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const connectionId = form.get('connection_id');
		const mode = form.get('mode');
		if (!connectionId || !mode) {
			return fail(400, { error: 'Missing connection data.' });
		}
		if (mode === 'write') {
			await locals.supabase
				.from('gmail_connections')
				.update({ mode: 'read' })
				.eq('user_id', user.id)
				.neq('id', connectionId)
				.eq('mode', 'write');
		}
		await locals.supabase
			.from('gmail_connections')
			.update({ mode })
			.eq('id', connectionId)
			.eq('user_id', user.id);
		throw redirect(303, params?.workspace ? `/${params.workspace}` : '/agentmvp');
	},

	disconnectConnection: async ({ request, locals, params }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const connectionId = form.get('connection_id');
		if (!connectionId) {
			return fail(400, { error: 'Missing connection id.' });
		}
		const { data: connection } = await locals.supabase
			.from('gmail_connections')
			.select('id, access_token, refresh_token')
			.eq('id', connectionId)
			.eq('user_id', user.id)
			.maybeSingle();
		const logStopResult = async (status, detail) => {
			console.log('gmail-stop', status, detail);
			await locals.supabase.from('ingestion_errors').insert({
				user_id: user.id,
				source: 'gmail-stop',
				detail: `${status}: ${detail}`
			});
		};
		if (connection?.access_token) {
			const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/stop', {
				method: 'POST',
				headers: { Authorization: `Bearer ${connection.access_token}` }
			});
			if (response.ok) {
				await logStopResult('stop_ok', `Stopped watch for connection ${connectionId}`);
			} else if (connection.refresh_token) {
				const body = new URLSearchParams({
					client_id: process.env.GOOGLE_CLIENT_ID ?? '',
					client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
					refresh_token: connection.refresh_token,
					grant_type: 'refresh_token'
				});
				const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body
				});
				if (refreshResponse.ok) {
					const refreshed = await refreshResponse.json();
					const stopResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/stop', {
						method: 'POST',
						headers: { Authorization: `Bearer ${refreshed.access_token}` }
					});
					if (stopResponse.ok) {
						await logStopResult(
							'stop_ok',
							`Stopped watch after refresh for connection ${connectionId}`
						);
					} else {
						const stopDetail = await stopResponse.text();
						await logStopResult(
							'stop_failed',
							`Failed after refresh for connection ${connectionId}: ${stopResponse.status} ${stopDetail}`
						);
					}
				} else {
					const refreshDetail = await refreshResponse.text();
					await logStopResult(
						'stop_failed',
						`Refresh failed for connection ${connectionId}: ${refreshResponse.status} ${refreshDetail}`
					);
				}
			} else {
				const stopDetail = await response.text();
				await logStopResult(
					'stop_failed',
					`Failed to stop for connection ${connectionId}: ${response.status} ${stopDetail}`
				);
			}
		}
		await locals.supabase
			.from('gmail_connections')
			.delete()
			.eq('id', connectionId)
			.eq('user_id', user.id);
		await locals.supabase
			.from('email_ingestion_state')
			.delete()
			.eq('connection_id', connectionId)
			.eq('user_id', user.id);
		throw redirect(303, params?.workspace ? `/${params.workspace}` : '/agentmvp');
	},

	createBuilding: async ({ request, locals, params }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const workspace = await getWorkspaceForUser(locals.supabase, user, params?.workspace ?? null);
		if (!workspace?.id) {
			return fail(400, { error: 'Workspace not found for user.' });
		}
		const form = await request.formData();
		const name = form.get('name');
		const address = form.get('address');
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Building name is required.' });
		}
		const { data, error } = await locals.supabase
			.from('properties')
			.insert({
				workspace_id: workspace.id,
				name: name.trim(),
				address: typeof address === 'string' && address.trim() ? address.trim() : null
			})
			.select('id, name')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { building: data };
	},

	createUnit: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const name = form.get('name');
		const buildingId = form.get('building_id');
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Unit name is required.' });
		}
		if (!buildingId || typeof buildingId !== 'string') {
			return fail(400, { error: 'Building is required.' });
		}
		const { data, error } = await locals.supabase
			.from('units')
			.insert({
				property_id: buildingId,
				name: name.trim()
			})
			.select('id, name, property_id')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { unit: data ? { ...data, building_id: data.property_id } : data };
	},

	createTenant: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const name = form.get('name');
		const email = form.get('email');
		const unitId = form.get('unit_id');
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Tenant name is required.' });
		}
		if (!email || typeof email !== 'string' || !email.trim()) {
			return fail(400, { error: 'Tenant email is required.' });
		}
		if (!unitId || typeof unitId !== 'string') {
			return fail(400, { error: 'Unit is required.' });
		}
		const { data, error } = await locals.supabase
			.from('tenants')
			.insert({
				user_id: user.id,
				unit_id: unitId,
				name: name.trim(),
				email: email.trim().toLowerCase()
			})
			.select('id, name, email, unit_id')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { tenant: data };
	},

	updateTenant: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const tenantId = form.get('tenant_id');
		const name = form.get('name');
		const email = form.get('email');
		if (!tenantId || typeof tenantId !== 'string') {
			return fail(400, { error: 'Tenant is required.' });
		}
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Tenant name is required.' });
		}
		if (!email || typeof email !== 'string' || !email.trim()) {
			return fail(400, { error: 'Tenant email is required.' });
		}
		const { data, error } = await locals.supabase
			.from('tenants')
			.update({
				name: name.trim(),
				email: email.trim().toLowerCase(),
				updated_at: new Date().toISOString()
			})
			.eq('id', tenantId)
			.select('id, name, email, unit_id')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { tenant: data };
	},

	deleteTenant: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const tenantId = form.get('tenant_id');
		if (!tenantId || typeof tenantId !== 'string') {
			return fail(400, { error: 'Tenant is required.' });
		}
		const { error } = await locals.supabase.from('tenants').delete().eq('id', tenantId);
		if (error) {
			return fail(500, { error: error.message });
		}
		return { tenantId };
	},

	createVendor: async ({ request, locals, params }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const workspace = await getWorkspaceForUser(locals.supabase, user, params?.workspace ?? null);
		if (!workspace?.id) {
			return fail(400, { error: 'Workspace not found for user.' });
		}
		const form = await request.formData();
		const name = form.get('name');
		const email = form.get('email');
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Vendor name is required.' });
		}
		const { data, error } = await locals.supabase
			.from('vendors')
			.insert({
				workspace_id: workspace.id,
				name: name.trim(),
				email: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null
			})
			.select('id, name')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { vendor: data };
	},

	updateVendorNote: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const vendorId = form.get('vendor_id');
		const note = form.get('note');
		if (!vendorId || typeof vendorId !== 'string') {
			return fail(400, { error: 'Vendor is required.' });
		}
		const { data, error } = await locals.supabase
			.from('vendors')
			.update({ note: typeof note === 'string' ? note : null })
			.eq('id', vendorId)
			.select('id, note')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { vendor: data };
	},

	updateVendorProfile: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const vendorId = form.get('vendor_id');
		const email = form.get('email');
		const phone = form.get('phone');
		const trade = form.get('trade');
		if (!vendorId || typeof vendorId !== 'string') {
			return fail(400, { error: 'Vendor is required.' });
		}
		const { data, error } = await locals.supabase
			.from('vendors')
			.update({
				email: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null,
				phone: typeof phone === 'string' && phone.trim() ? phone.trim() : null,
				trade: typeof trade === 'string' && trade.trim() ? trade.trim() : null
			})
			.eq('id', vendorId)
			.select('id, email, phone, trade')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { vendor: data };
	},

	updateVendorDetails: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const vendorId = form.get('vendor_id');
		const email = form.get('email');
		const phone = form.get('phone');
		const trade = form.get('trade');
		const note = form.get('note');
		if (!vendorId || typeof vendorId !== 'string') {
			return fail(400, { error: 'Vendor is required.' });
		}
		const { data, error } = await locals.supabase
			.from('vendors')
			.update({
				email: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null,
				phone: typeof phone === 'string' && phone.trim() ? phone.trim() : null,
				trade: typeof trade === 'string' && trade.trim() ? trade.trim() : null,
				note: typeof note === 'string' ? note : null
			})
			.eq('id', vendorId)
			.select('id, email, phone, trade, note')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { vendor: data };
	},

	renameIssue: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const issueId = form.get('issue_id');
		const name = form.get('name');
		if (!issueId || typeof issueId !== 'string') {
			return fail(400, { error: 'Issue is required.' });
		}
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Name is required.' });
		}
		const { data, error } = await locals.supabase
			.from('issues')
			.update({ name: name.trim() })
			.eq('id', issueId)
			.select('id, name')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { issue: data };
	},

	deleteIssue: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const issueId = form.get('issue_id');
		if (!issueId || typeof issueId !== 'string') {
			return fail(400, { error: 'Issue is required.' });
		}
		const { error } = await locals.supabase.from('issues').delete().eq('id', issueId);
		if (error) {
			return fail(500, { error: error.message });
		}
		return { issueId };
	},

	resetIssues: async ({ locals, params }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const workspace = await getWorkspaceForUser(locals.supabase, user, params?.workspace ?? null);
		if (!workspace?.id) {
			return fail(400, { error: 'Workspace not found for user.' });
		}
		const { error } = await locals.supabase
			.from('issues')
			.delete()
			.eq('workspace_id', workspace.id);
		if (error) {
			return fail(500, { error: error.message });
		}
		return { ok: true };
	},

	renameBuilding: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const buildingId = form.get('building_id');
		const name = form.get('name');
		if (!buildingId || typeof buildingId !== 'string') {
			return fail(400, { error: 'Building is required.' });
		}
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Name is required.' });
		}
		const { data, error } = await locals.supabase
			.from('properties')
			.update({ name: name.trim() })
			.eq('id', buildingId)
			.select('id, name')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { building: data };
	},

	deleteBuilding: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const buildingId = form.get('building_id');
		if (!buildingId || typeof buildingId !== 'string') {
			return fail(400, { error: 'Building is required.' });
		}
		const { error } = await locals.supabase.from('properties').delete().eq('id', buildingId);
		if (error) {
			return fail(500, { error: error.message });
		}
		return { buildingId };
	},

	renameVendor: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const vendorId = form.get('vendor_id');
		const name = form.get('name');
		if (!vendorId || typeof vendorId !== 'string') {
			return fail(400, { error: 'Vendor is required.' });
		}
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Name is required.' });
		}
		const { data, error } = await locals.supabase
			.from('vendors')
			.update({ name: name.trim() })
			.eq('id', vendorId)
			.select('id, name')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { vendor: data };
	},

	deleteVendor: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const vendorId = form.get('vendor_id');
		if (!vendorId || typeof vendorId !== 'string') {
			return fail(400, { error: 'Vendor is required.' });
		}
		const { error } = await locals.supabase.from('vendors').delete().eq('id', vendorId);
		if (error) {
			return fail(500, { error: error.message });
		}
		return { vendorId };
	},

	approveAction: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const actionId = form.get('action_id');
		const emailBodyOverride = form.get('email_body');
		if (!actionId || typeof actionId !== 'string') {
			return fail(400, { error: 'Action is required.' });
		}
		if (emailBodyOverride !== null && typeof emailBodyOverride !== 'string') {
			return fail(400, { error: 'Email body must be a string.' });
		}

		const { data: actionRow, error: actionError } = await locals.supabase
			.from('tasks')
			.select(
				'id, issue_id, action_type, title, detail, status, email_body, vendor_email_subject, vendor_email_to'
			)
			.eq('id', actionId)
			.maybeSingle();
		if (actionError || !actionRow?.id) {
			return fail(404, { error: 'Action not found.' });
		}
		if (!actionRow.issue_id) {
			return fail(400, { error: 'Action has no issue.' });
		}

		const { data: issueRow, error: issueError } = await locals.supabase
			.from('issues')
			.select('id, name, description, tenant_id, unit_id, vendor_id, suggested_vendor_id')
			.eq('id', actionRow.issue_id)
			.maybeSingle();
		if (issueError || !issueRow?.id) {
			return fail(404, { error: 'Issue not found.' });
		}

		const { data: sendConnection } = await locals.supabase
			.from('gmail_connections')
			.select('id, email, access_token, refresh_token, expires_at, mode')
			.eq('user_id', user.id)
			.in('mode', ['write', 'both'])
			.order('updated_at', { ascending: false })
			.limit(1)
			.maybeSingle();
		if (!sendConnection?.access_token) {
			return fail(400, { error: 'No writable Gmail connection found.' });
		}

		const refreshAccessToken = async () => {
			if (!sendConnection.refresh_token) return sendConnection.access_token;
			if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
				throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in server env.');
			}
			const body = new URLSearchParams({
				client_id: env.GOOGLE_CLIENT_ID ?? '',
				client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
				refresh_token: sendConnection.refresh_token,
				grant_type: 'refresh_token'
			});
			const response = await fetch('https://oauth2.googleapis.com/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body
			});
			if (!response.ok) {
				throw new Error(await response.text());
			}
			const refreshed = await response.json();
			const accessToken = refreshed.access_token;
			const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
			await locals.supabase
				.from('gmail_connections')
				.update({
					access_token: accessToken,
					expires_at: newExpiresAt,
					updated_at: new Date().toISOString()
				})
				.eq('id', sendConnection.id);
			return accessToken;
		};

		let accessToken = sendConnection.access_token;
		const expiresAt = new Date(sendConnection.expires_at).getTime();
		const refreshNeeded = Number.isNaN(expiresAt) || expiresAt - Date.now() < 120000;
		if (refreshNeeded) {
			accessToken = await refreshAccessToken();
		}

		const encodeBase64Url = (input) =>
			Buffer.from(input, 'utf-8')
				.toString('base64')
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/g, '');

		const actionType = actionRow.action_type ?? 'triage_issue';
		const effectiveEmailBody =
			emailBodyOverride !== null ? emailBodyOverride : (actionRow.email_body ?? '');

		if (actionType === 'triage_issue') {
			if (!effectiveEmailBody) {
				return fail(400, { error: 'Action has no email body.' });
			}
			if (emailBodyOverride !== null) {
				await locals.supabase
					.from('tasks')
					.update({ email_body: effectiveEmailBody, updated_at: new Date().toISOString() })
					.eq('id', actionRow.id);
			}
			const { data: tenantRow } = await locals.supabase
				.from('tenants')
				.select('id, name, email')
				.eq('id', issueRow.tenant_id)
				.maybeSingle();
			if (!tenantRow?.email) {
				return fail(400, { error: 'Tenant has no email.' });
			}

			const { data: threadRows } = await locals.supabase
				.from('threads')
				.select('id, external_id, participant_type')
				.eq('issue_id', issueRow.id)
				.eq('participant_type', 'tenant');
			const threadIds = (threadRows ?? []).map((thread) => thread.id);
			if (!threadIds.length) {
				return fail(400, { error: 'No thread found for this issue.' });
			}
			const { data: latestMessage } = await locals.supabase
				.from('messages')
				.select('thread_id, subject, timestamp, external_id')
				.in('thread_id', threadIds)
				.order('timestamp', { ascending: false })
				.limit(1)
				.maybeSingle();
			let replySourceMessageId = latestMessage?.external_id ?? null;
			if (!replySourceMessageId) {
				const { data: fallbackMessage } = await locals.supabase
					.from('messages')
					.select('external_id')
					.in('thread_id', threadIds)
					.not('external_id', 'is', null)
					.order('timestamp', { ascending: false })
					.limit(1)
					.maybeSingle();
				replySourceMessageId = fallbackMessage?.external_id ?? null;
			}
			const targetThreadId = latestMessage?.thread_id ?? threadIds[0];
			let threadExternalId =
				threadRows?.find((thread) => thread.id === targetThreadId)?.external_id ??
				threadRows?.[0]?.external_id ??
				null;
			if (!threadExternalId && replySourceMessageId) {
				const messageResponse = await fetch(
					`https://gmail.googleapis.com/gmail/v1/users/me/messages/${replySourceMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
					{
						method: 'GET',
						headers: {
							Authorization: `Bearer ${accessToken}`,
							'Content-Type': 'application/json'
						}
					}
				);
				if (messageResponse.ok) {
					const messagePayload = await messageResponse.json();
					threadExternalId = messagePayload?.threadId ?? null;
				}
			}
			if (!threadExternalId) {
				return fail(400, { error: 'Missing Gmail thread id for reply.' });
			}
			if (!replySourceMessageId) {
				return fail(400, { error: 'Missing Gmail message id for reply headers.' });
			}

			const headerResponse = await fetch(
				`https://gmail.googleapis.com/gmail/v1/users/me/messages/${replySourceMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
				{
					method: 'GET',
					headers: {
						Authorization: `Bearer ${accessToken}`,
						'Content-Type': 'application/json'
					}
				}
			);
			if (!headerResponse.ok) {
				return fail(500, { error: await headerResponse.text() });
			}
			const headerPayload = await headerResponse.json();
			const messageHeaders = headerPayload?.payload?.headers ?? [];
			const messageIdHeader =
				messageHeaders.find((header) => header.name?.toLowerCase() === 'message-id')?.value ?? null;
			const referencesHeader =
				messageHeaders.find((header) => header.name?.toLowerCase() === 'references')?.value ?? null;
			if (!messageIdHeader) {
				return fail(400, { error: 'Missing Message-ID for reply headers.' });
			}
			const baseSubject = latestMessage?.subject ?? issueRow.name ?? 'Maintenance request';
			const replySubject = baseSubject.startsWith('Re:') ? baseSubject : `Re: ${baseSubject}`;
			const replyReferences = referencesHeader
				? `${referencesHeader} ${messageIdHeader}`
				: messageIdHeader;
			const raw = encodeBase64Url(
				`To: ${tenantRow.email}\r\nSubject: ${replySubject}\r\nIn-Reply-To: ${messageIdHeader}\r\nReferences: ${replyReferences}\r\n\r\n${effectiveEmailBody}`
			);
			const sendResponse = await fetch(
				'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(threadExternalId ? { raw, threadId: threadExternalId } : { raw })
				}
			);
			if (!sendResponse.ok) {
				return fail(500, { error: await sendResponse.text() });
			}
			const sendPayload = await sendResponse.json();

			await locals.supabase.from('messages').insert({
				thread_id: targetThreadId,
				external_id: sendPayload.id ?? null,
				message: effectiveEmailBody,
				sender: 'agent',
				subject: replySubject,
				timestamp: new Date().toISOString(),
				channel: 'gmail',
				direction: 'outbound',
				delivery_status: 'sent',
				connection_id: sendConnection.id,
				issue_id: issueRow.id,
				thread_external_id: threadExternalId
			});

			await locals.supabase.from('tasks').update({ status: 'approved' }).eq('id', actionRow.id);
			return { actionId };
		}

		const vendorEmailTo =
			actionRow.vendor_email_to && actionRow.vendor_email_to.trim()
				? actionRow.vendor_email_to.trim()
				: null;
		if (vendorEmailTo) {
			if (!effectiveEmailBody) {
				return fail(400, { error: 'Action has no email body.' });
			}
			const subject = actionRow.vendor_email_subject || `Cleaning request: ${issueRow.name}`;
			const raw = encodeBase64Url(
				`To: ${vendorEmailTo}\r\nSubject: ${subject}\r\n\r\n${effectiveEmailBody}`
			);
			const sendResponse = await fetch(
				'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({ raw })
				}
			);
			if (!sendResponse.ok) {
				return fail(500, { error: await sendResponse.text() });
			}
			await locals.supabase
				.from('issues')
				.update({ status: 'escalated', vendor_id: null })
				.eq('id', issueRow.id);
			await locals.supabase.from('tasks').update({ status: 'approved' }).eq('id', actionRow.id);
			return { actionId };
		}

		const vendorId = issueRow.suggested_vendor_id ?? issueRow.vendor_id;
		if (!vendorId) {
			await locals.supabase.from('tasks').update({ status: 'approved' }).eq('id', actionRow.id);
			return { actionId };
		}

		const { data: vendorRow, error: vendorError } = await locals.supabase
			.from('vendors')
			.select('id, name, email')
			.eq('id', vendorId)
			.maybeSingle();
		if (vendorError || !vendorRow?.id) {
			return fail(404, { error: 'Vendor not found.' });
		}
		if (!vendorRow.email) {
			return fail(400, { error: 'Vendor has no email.' });
		}

		const { data: unitRow } = await locals.supabase
			.from('units')
			.select('id, name, property_id')
			.eq('id', issueRow.unit_id)
			.maybeSingle();
		const { data: buildingRow } = unitRow?.property_id
			? await locals.supabase
					.from('properties')
					.select('id, name, address')
					.eq('id', unitRow.property_id)
					.maybeSingle()
			: { data: null };
		const { data: tenantRow } = await locals.supabase
			.from('tenants')
			.select('id, name, email, phone')
			.eq('id', issueRow.tenant_id)
			.maybeSingle();

		const { data: threadRows } = await locals.supabase
			.from('threads')
			.select('id')
			.eq('issue_id', issueRow.id)
			.eq('participant_type', 'tenant');
		const threadIds = (threadRows ?? []).map((thread) => thread.id);
		let latestTenantMessage = null;
		if (threadIds.length) {
			const { data: latestMessages } = await locals.supabase
				.from('messages')
				.select('message, timestamp')
				.in('thread_id', threadIds)
				.eq('sender', 'tenant')
				.order('timestamp', { ascending: false })
				.limit(1);
			latestTenantMessage = latestMessages?.[0]?.message ?? null;
		}

		const subject = actionRow.vendor_email_subject || `Maintenance request: ${issueRow.name}`;
		const buildingName = buildingRow?.name ?? 'Unknown building';
		const unitName = unitRow?.name ?? 'Unknown unit';
		const tenantName = tenantRow?.name ?? 'Tenant';
		const tenantContact = [tenantRow?.email, tenantRow?.phone].filter(Boolean).join(' · ');
		const tenantLine = tenantContact ? `${tenantName} (${tenantContact})` : tenantName;
		const fallbackBody = [
			`Hi ${vendorRow.name || 'there'},`,
			'',
			`Can you help with this maintenance request?`,
			'',
			`Issue: ${issueRow.name}`,
			`Property: ${buildingName}${buildingRow?.address ? `, ${buildingRow.address}` : ''}`,
			`Unit: ${unitName}`,
			`Tenant: ${tenantLine}`,
			issueRow.description ? `Summary: ${issueRow.description}` : null,
			latestTenantMessage ? `Tenant update: "${latestTenantMessage}"` : null,
			'',
			`Please confirm your availability and the earliest time you can come.`,
			'',
			`Thanks,`,
			user.user_metadata?.name ?? user.email ?? 'Property manager'
		]
			.filter(Boolean)
			.join('\n');

		const bodyLines = effectiveEmailBody || fallbackBody;

		const raw = encodeBase64Url(
			`To: ${vendorRow.email}\r\nSubject: ${subject}\r\n\r\n${bodyLines}`
		);
		const sendResponse = await fetch(
			'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ raw })
			}
		);
		if (!sendResponse.ok) {
			return fail(500, { error: await sendResponse.text() });
		}
		const sendPayload = await sendResponse.json();

		let vendorThreadId = null;
		const { data: vendorThreads } = await locals.supabase
			.from('threads')
			.select('id')
			.eq('issue_id', issueRow.id)
			.eq('participant_type', 'vendor')
			.eq('participant_id', vendorId)
			.limit(1);
		if (vendorThreads?.length) {
			vendorThreadId = vendorThreads[0].id;
		} else {
			const { data: createdThread } = await locals.supabase
				.from('threads')
				.insert({
					issue_id: issueRow.id,
					name: `Vendor thread: ${vendorRow.name}`,
					participant_type: 'vendor',
					participant_id: vendorId,
					connection_id: sendConnection.id,
					workspace_id: issueRow.workspace_id
				})
				.select('id')
				.single();
			vendorThreadId = createdThread?.id ?? null;
		}

		if (vendorThreadId) {
			await locals.supabase.from('messages').insert({
				thread_id: vendorThreadId,
				external_id: sendPayload.id ?? null,
				message: bodyLines,
				sender: 'agent',
				subject,
				timestamp: new Date().toISOString(),
				channel: 'vendor',
				direction: 'outbound',
				delivery_status: 'sent',
				connection_id: sendConnection.id,
				issue_id: issueRow.id
			});
		}

		await locals.supabase
			.from('issues')
			.update({ status: 'escalated', vendor_id: vendorId })
			.eq('id', issueRow.id);

		await locals.supabase.from('tasks').update({ status: 'approved' }).eq('id', actionRow.id);
		return { actionId };
	},

	denyAction: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const actionId = form.get('action_id');
		if (!actionId || typeof actionId !== 'string') {
			return fail(400, { error: 'Action is required.' });
		}
		const { error } = await locals.supabase
			.from('tasks')
			.update({ status: 'denied' })
			.eq('id', actionId);
		if (error) {
			return fail(500, { error: error.message });
		}
		return { actionId };
	},

	updateActionDraft: async ({ request, locals }) => {
		const user = locals.user;
		if (!user) throw redirect(303, '/agentmvp');
		const form = await request.formData();
		const actionId = form.get('action_id');
		const emailBody = form.get('email_body');
		if (!actionId || typeof actionId !== 'string') {
			return fail(400, { error: 'Action is required.' });
		}
		if (emailBody !== null && typeof emailBody !== 'string') {
			return fail(400, { error: 'Email body must be a string.' });
		}
		const { data: actionRow, error: actionError } = await locals.supabase
			.from('tasks')
			.select('id')
			.eq('id', actionId)
			.maybeSingle();
		if (actionError || !actionRow?.id) {
			return fail(404, { error: 'Action not found.' });
		}
		const { error } = await locals.supabase
			.from('tasks')
			.update({ email_body: emailBody ?? '', updated_at: new Date().toISOString() })
			.eq('id', actionId);
		if (error) {
			return fail(500, { error: error.message });
		}
		return { actionId };
	}
};
