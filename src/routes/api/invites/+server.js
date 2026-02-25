import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { env } from '$env/dynamic/private';

export const POST = async ({ locals, request, url }) => {
	const user = locals.user;
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Verify caller is an admin
	const { data: member } = await supabaseAdmin
		.from('members')
		.select('workspace_id, role')
		.eq('user_id', user.id)
		.maybeSingle();

	if (!member || member.role !== 'admin') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const body = await request.json();
	const invites = body.invites ?? [];
	const invited = [];

	for (const { email, role } of invites) {
		if (!email || !role) continue;

		const { data: invite, error } = await supabaseAdmin
			.from('invites')
			.insert({
				workspace_id: member.workspace_id,
				email,
				role,
				invited_by: user.id
			})
			.select('token')
			.single();

		if (error) continue;

		// Send invite email via Mailgun
		const mailgunDomain = env.MAILGUN_DOMAIN ?? '';
		const mailgunFrom = env.MAILGUN_FROM ?? `Bedrock <noreply@${mailgunDomain}>`;
		const origin = url.origin;
		const inviteLink = `${origin}/accept-invite?token=${invite.token}`;

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
					console.error('[invites] Mailgun error', mailRes.status, detail);
				} else {
					console.log('[invites] Email sent to', email, 'link:', inviteLink);
				}
			} catch (e) {
				console.error('[invites] Mailgun fetch failed', e);
			}
		} else {
			console.warn('[invites] Skipping email — MAILGUN_DOMAIN or MAILGUN_API_KEY not set. Invite link:', inviteLink);
		}

		invited.push(email);
	}

	return json({ invited });
};
