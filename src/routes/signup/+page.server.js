import { fail, redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { env } from '$env/dynamic/private';

export const load = async ({ locals, url }) => {
	if (locals.user) throw redirect(303, '/agentmvp');
	const inviteToken = url.searchParams.get('invite');
	return { inviteToken, isInvite: !!inviteToken };
};

const bootstrap = async (user) => {
	const name = user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User';

	const { data: existingMember } = await supabaseAdmin
		.from('members')
		.select('workspace_id')
		.eq('user_id', user.id)
		.maybeSingle();

	if (existingMember) return;

	// Must create public.users row first — workspaces.admin_user_id references it
	await supabaseAdmin.from('users').upsert({ id: user.id, name });

	const { data: workspace, error: workspaceError } = await supabaseAdmin
		.from('workspaces')
		.insert({ admin_user_id: user.id, name: `${name}'s Team`, slug: user.id })
		.select('id')
		.single();

	if (workspaceError) throw new Error(workspaceError.message);

	await supabaseAdmin.from('members').insert({ workspace_id: workspace.id, user_id: user.id, role: 'admin' });
};

/** @returns {Promise<string|null>} workspace slug, or null if invite invalid */
const acceptInvite = async (user, token) => {
	const { data: invite } = await supabaseAdmin
		.from('invites')
		.select('*, workspaces(slug)')
		.eq('token', token)
		.maybeSingle();

	if (!invite || invite.accepted_at || new Date(invite.expires_at) < new Date()) return null;
	if (invite.email !== user.email) return null;

	const name = user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User';
	await supabaseAdmin.from('users').upsert({ id: user.id, name });
	await supabaseAdmin.from('members').insert({ workspace_id: invite.workspace_id, user_id: user.id, role: invite.role });
	await supabaseAdmin.from('invites').update({ accepted_at: new Date().toISOString() }).eq('token', token);

	return invite.workspaces?.slug ?? null;
};

export const actions = {
	contact: async ({ request }) => {
		const data = await request.formData();
		const name = data.get('name')?.trim();
		const email = data.get('email')?.trim();
		const role = data.get('role');
		const units = data.get('units');
		const currentSoftware = data.get('currentSoftware')?.trim();
		const painPoint = data.get('painPoint')?.trim();

		if (!name || !email) return fail(400, { error: 'Name and email are required.' });

		const mailgunDomain = env.MAILGUN_DOMAIN ?? '';
		const mailgunApiKey = env.MAILGUN_API_KEY ?? '';
		if (mailgunDomain && mailgunApiKey) {
			try {
				const body = new FormData();
				body.append('from', env.MAILGUN_FROM ?? `Bedrock <noreply@${mailgunDomain}>`);
				body.append('to', 'nicoluo@gmail.com');
				body.append('subject', `New Bedrock interest — ${name}`);
				body.append('text', `Name: ${name}\nEmail: ${email}\nRole: ${role}\nUnits managed: ${units}\nCurrent software: ${currentSoftware}\nBiggest pain point:\n\n${painPoint}`);
				const mailRes = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
					method: 'POST',
					headers: { Authorization: `Basic ${Buffer.from(`api:${mailgunApiKey}`).toString('base64')}` },
					body
				});
				if (!mailRes.ok) {
					const detail = await mailRes.text();
					console.error('[contact] Mailgun error', mailRes.status, detail);
				}
			} catch (e) {
				console.error('[contact] Mailgun fetch failed', e);
			}
		} else {
			console.warn('[contact] Skipping email — MAILGUN_DOMAIN or MAILGUN_API_KEY not set.');
		}

		return { success: true };
	},

	signup: async ({ request, locals, url }) => {
		const form = await request.formData();
		const name = form.get('name');
		const email = form.get('email');
		const password = form.get('password');
		const inviteToken = form.get('invite_token') || null;

		if (!name || !email || !password) {
			return fail(400, { error: 'All fields are required.' });
		}

		const { data, error } = await locals.supabase.auth.signUp({
			email,
			password,
			options: { data: { name } }
		});

		if (error) return fail(400, { error: error.message });
		if (!data.user) return fail(400, { error: 'Signup failed. Please try again.' });

		if (inviteToken) {
			const workspaceSlug = await acceptInvite(data.user, inviteToken);
			throw redirect(303, workspaceSlug ? `/${workspaceSlug}` : '/agentmvp');
		}

		await bootstrap(data.user);
		throw redirect(303, '/agentmvp');
	}
};
