// @ts-nocheck
import crypto from 'node:crypto';
import { error, fail } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

export const load = async ({ parent }) => {
	const { workspace } = await parent();
	if (!workspace?.id) throw error(404, 'Workspace not found');

	const [{ data: workspaceRow }, { data: apiKeys }] = await Promise.all([
		supabaseAdmin
			.from('workspaces')
			.select('id, coordinator_chat_guid, coordinator_bedrock_handles, coordinator_label')
			.eq('id', workspace.id)
			.maybeSingle(),
		supabaseAdmin
			.from('workspace_api_keys')
			.select('id, name, key_prefix, scope, last_used_at, created_at')
			.eq('workspace_id', workspace.id)
			.eq('scope', 'imessage_ingest')
			.order('created_at', { ascending: false })
	]);

	return {
		coordinatorSettings: {
			chatGuid: workspaceRow?.coordinator_chat_guid ?? '',
			bedrockHandles: workspaceRow?.coordinator_bedrock_handles ?? [],
			coordinatorLabel: workspaceRow?.coordinator_label ?? 'Jose',
			apiKeys: apiKeys ?? []
		}
	};
};

export const actions = {
	save: async ({ request, locals, parent }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		const { workspace } = await parent();
		if (!workspace?.id) return fail(404, { error: 'No workspace' });

		const form = await request.formData();
		const chatGuid = String(form.get('chat_guid') ?? '').trim();
		const handlesRaw = String(form.get('bedrock_handles') ?? '').trim();
		const coordinatorLabel = String(form.get('coordinator_label') ?? '').trim() || 'Jose';

		const bedrockHandles = handlesRaw
			.split(/[,\n]/)
			.map((s) => s.trim())
			.filter(Boolean);

		const { error: err } = await supabaseAdmin
			.from('workspaces')
			.update({
				coordinator_chat_guid: chatGuid || null,
				coordinator_bedrock_handles: bedrockHandles,
				coordinator_label: coordinatorLabel
			})
			.eq('id', workspace.id);

		if (err) return fail(500, { error: err.message });
		return { success: true };
	},

	generateKey: async ({ request, locals, parent }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		const { workspace } = await parent();
		if (!workspace?.id) return fail(404, { error: 'No workspace' });

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim() || 'iMessage sync';

		const raw = `brk_${crypto.randomBytes(24).toString('base64url')}`;
		const { error: err } = await supabaseAdmin.from('workspace_api_keys').insert({
			workspace_id: workspace.id,
			name,
			key_hash: hashKey(raw),
			key_prefix: raw.slice(0, 12),
			scope: 'imessage_ingest',
			created_by: locals.user.id
		});
		if (err) return fail(500, { error: err.message });
		return { success: true, newKey: raw };
	},

	revokeKey: async ({ request, locals, parent }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		const { workspace } = await parent();
		if (!workspace?.id) return fail(404, { error: 'No workspace' });

		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (!id) return fail(400, { error: 'id required' });

		const { error: err } = await supabaseAdmin
			.from('workspace_api_keys')
			.delete()
			.eq('id', id)
			.eq('workspace_id', workspace.id);
		if (err) return fail(500, { error: err.message });
		return { success: true };
	}
};
