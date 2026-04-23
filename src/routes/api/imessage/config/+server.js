// @ts-nocheck
import { json } from '@sveltejs/kit';
import crypto from 'node:crypto';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

async function resolveApiKey(request) {
	const auth = request.headers.get('authorization') ?? '';
	const match = auth.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const { data } = await supabaseAdmin
		.from('workspace_api_keys')
		.select('id, workspace_id, scope')
		.eq('key_hash', hashKey(match[1].trim()))
		.maybeSingle();
	return data ?? null;
}

export const POST = async ({ request }) => {
	const apiKey = await resolveApiKey(request);
	if (!apiKey || apiKey.scope !== 'imessage_ingest') {
		return json({ error: 'Invalid API key' }, { status: 401 });
	}
	const body = await request.json().catch(() => null);
	if (!body) return json({ error: 'Bad JSON' }, { status: 400 });

	const update = {};
	if (typeof body.chat_guid === 'string') update.coordinator_chat_guid = body.chat_guid || null;
	if (Array.isArray(body.bedrock_handles)) {
		update.coordinator_bedrock_handles = body.bedrock_handles
			.map((h) => String(h).trim())
			.filter(Boolean);
	}
	if (typeof body.coordinator_label === 'string' && body.coordinator_label.trim()) {
		update.coordinator_label = body.coordinator_label.trim();
	}
	if (!Object.keys(update).length) return json({ updated: 0 });

	const { error } = await supabaseAdmin
		.from('workspaces')
		.update(update)
		.eq('id', apiKey.workspace_id);
	if (error) return json({ error: error.message }, { status: 500 });

	return json({ ok: true, updated: Object.keys(update) });
};
