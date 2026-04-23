// @ts-nocheck
import { json } from '@sveltejs/kit';
import crypto from 'node:crypto';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

const unauthorized = (reason) => json({ error: reason }, { status: 401 });
const badRequest = (reason) => json({ error: reason }, { status: 400 });

async function resolveApiKey(request) {
	const auth = request.headers.get('authorization') ?? '';
	const match = auth.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const keyHash = hashKey(match[1].trim());
	const { data } = await supabaseAdmin
		.from('workspace_api_keys')
		.select('id, workspace_id, scope')
		.eq('key_hash', keyHash)
		.maybeSingle();
	return data ?? null;
}

async function ensureCoordinatorThread(workspace) {
	if (workspace.coordinator_thread_id) return workspace.coordinator_thread_id;
	const { data: thread, error } = await supabaseAdmin
		.from('threads')
		.insert({
			workspace_id: workspace.id,
			participant_type: 'coordinator',
			name: workspace.coordinator_label || 'Coordinator'
		})
		.select('id')
		.single();
	if (error) throw new Error(`thread insert: ${error.message}`);
	await supabaseAdmin
		.from('workspaces')
		.update({ coordinator_thread_id: thread.id })
		.eq('id', workspace.id);
	return thread.id;
}

function resolveSender(msg, bedrockHandles, coordinatorLabel) {
	const isFromMe = msg.is_from_me === 1 || msg.is_from_me === true;
	const handle = msg.sender_handle ?? null;
	const isBedrock = isFromMe || (handle && bedrockHandles.includes(handle));
	if (isBedrock) {
		return {
			direction: 'outbound',
			sender: 'manager',
			sender_name: 'Bedrock'
		};
	}
	return {
		direction: 'inbound',
		sender: 'vendor',
		sender_name: coordinatorLabel || 'Coordinator'
	};
}

export const POST = async ({ request }) => {
	const apiKey = await resolveApiKey(request);
	if (!apiKey) return unauthorized('Invalid API key');
	if (apiKey.scope !== 'imessage_ingest') return unauthorized('Invalid scope');

	const payload = await request.json().catch(() => null);
	if (!payload || !Array.isArray(payload.messages)) {
		return badRequest('Expected { messages: [...] }');
	}
	if (payload.messages.length > 500) {
		return badRequest('Too many messages in one batch (max 500)');
	}

	const { data: workspace, error: wsError } = await supabaseAdmin
		.from('workspaces')
		.select('id, coordinator_label, coordinator_bedrock_handles, coordinator_thread_id')
		.eq('id', apiKey.workspace_id)
		.single();
	if (wsError || !workspace) return unauthorized('Workspace not found');

	const threadId = await ensureCoordinatorThread(workspace);
	const bedrockHandles = workspace.coordinator_bedrock_handles ?? [];
	const coordinatorLabel = workspace.coordinator_label ?? 'Coordinator';

	let inserted = 0;
	let skipped = 0;
	const errors = [];

	for (const raw of payload.messages) {
		const guid = typeof raw?.guid === 'string' ? raw.guid.trim() : '';
		const text = typeof raw?.text === 'string' ? raw.text : '';
		const dateIso = typeof raw?.date_iso === 'string' ? raw.date_iso : null;
		if (!guid || !text || !dateIso) {
			skipped += 1;
			continue;
		}

		const { data: existing } = await supabaseAdmin
			.from('messages')
			.select('id')
			.eq('external_id', guid)
			.maybeSingle();
		if (existing) {
			skipped += 1;
			continue;
		}

		const { direction, sender, sender_name } = resolveSender(
			raw,
			bedrockHandles,
			coordinatorLabel
		);

		const metadata = {
			sender_name,
			raw_handle: raw.sender_handle ?? null,
			imessage_rowid: raw.rowid ?? null
		};

		const { error: insertError } = await supabaseAdmin.from('messages').insert({
			workspace_id: workspace.id,
			thread_id: threadId,
			issue_id: null,
			external_id: guid,
			channel: 'imessage',
			direction,
			sender,
			message: text,
			subject: null,
			timestamp: dateIso,
			metadata
		});

		if (insertError) {
			errors.push({ guid, error: insertError.message });
			continue;
		}
		inserted += 1;
	}

	await supabaseAdmin
		.from('workspace_api_keys')
		.update({ last_used_at: new Date().toISOString() })
		.eq('id', apiKey.id);

	return json({ inserted, skipped, errors });
};
