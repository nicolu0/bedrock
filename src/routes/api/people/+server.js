// @ts-nocheck
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data: people } = await supabaseAdmin
		.from('people')
		.select('id, name, email, role, trade, notes, pending, created_at')
		.eq('workspace_id', workspace.id)
		.order('name', { ascending: true });

	return json(people ?? []);
};

export const POST = async ({ locals, request, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { workspace: workspaceSlug, name, email, role, trade, notes } = body;

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data, error } = await supabaseAdmin
		.from('people')
		.insert({
			workspace_id: workspace.id,
			name,
			email,
			role,
			trade,
			notes,
			pending: true,
			user_id: null
		})
		.select('id, name, email, role, trade, notes, pending, created_at')
		.single();

	if (error) {
		return json({ error: error.message }, { status: 500 });
	}

	let inviteToken = null;
	if (email) {
		const { data: invite, error: inviteError } = await supabaseAdmin
			.from('invites')
			.insert({
				workspace_id: workspace.id,
				email,
				role,
				invited_by: locals.user.id,
				people_id: data.id
			})
			.select('token')
			.single();

		if (inviteError) {
			await supabaseAdmin.from('people').delete().eq('id', data.id);
			return json({ error: inviteError.message }, { status: 500 });
		}

		inviteToken = invite?.token ?? null;
	}

	if (inviteToken) {
		const mailgunDomain = env.MAILGUN_DOMAIN ?? '';
		const mailgunFrom = env.MAILGUN_FROM ?? `Bedrock <noreply@${mailgunDomain}>`;
		const origin = url.origin;
		const inviteLink = `${origin}/signup?invite=${inviteToken}`;

		const mailgunApiKey = env.MAILGUN_API_KEY ?? '';
		if (mailgunDomain && mailgunApiKey) {
			try {
				const formData = new FormData();
				formData.append('from', mailgunFrom);
				formData.append('to', email);
				formData.append('subject', "You're invited to Bedrock");
				formData.append(
					'text',
					`You've been invited to join a team on Bedrock.\n\nAccept your invite here:\n${inviteLink}\n\nThis link expires in 7 days.`
				);

				const mailRes = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
					method: 'POST',
					headers: {
						Authorization: `Basic ${Buffer.from(`api:${mailgunApiKey}`).toString('base64')}`
					},
					body: formData
				});
				if (!mailRes.ok) {
					const detail = await mailRes.text();
					console.error('[people] Mailgun error', mailRes.status, detail);
				} else {
					console.log('[people] Email sent to', email, 'link:', inviteLink);
				}
			} catch (e) {
				console.error('[people] Mailgun fetch failed', e);
			}
		} else {
			console.warn(
				'[people] Skipping email — MAILGUN_DOMAIN or MAILGUN_API_KEY not set. Invite link:',
				inviteLink
			);
		}
	}

	return json(data);
};

export const PATCH = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { id, workspace: workspaceSlug, name, email, role, trade, notes } = body;

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data, error } = await supabaseAdmin
		.from('people')
		.update({ name, email, role, trade, notes, updated_at: new Date().toISOString() })
		.eq('id', id)
		.eq('workspace_id', workspace.id)
		.select('id, name, email, role, trade, notes, pending, created_at')
		.single();

	if (error) {
		return json({ error: error.message }, { status: 500 });
	}

	return json(data);
};

export const DELETE = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { id, workspace: workspaceSlug } = body;

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { error } = await supabaseAdmin
		.from('people')
		.delete()
		.eq('id', id)
		.eq('workspace_id', workspace.id);

	if (error) {
		return json({ error: error.message }, { status: 500 });
	}

	return json({ id });
};
