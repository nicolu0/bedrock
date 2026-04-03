// @ts-nocheck
import { json } from '@sveltejs/kit';
import { SUPABASE_SERVICE_ROLE_KEY } from '$env/static/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const mapMessageToUi = (message) => ({
	id: message.id,
	sender: message.sender === 'assistant' ? 'agent' : 'tenant',
	message: message.content,
	timestamp: message.created_at
});

const resolveWorkspace = async (workspaceId, workspaceSlug) => {
	if (workspaceId) {
		const { data } = await supabaseAdmin
			.from('workspaces')
			.select('id, name, slug')
			.eq('id', workspaceId)
			.maybeSingle();
		return data ?? null;
	}
	if (workspaceSlug) {
		const { data } = await supabaseAdmin
			.from('workspaces')
			.select('id, name, slug')
			.eq('slug', workspaceSlug)
			.maybeSingle();
		return data ?? null;
	}
	return null;
};

export const GET = async ({ locals, url }) => {
	if (!locals?.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const workspaceId = url.searchParams.get('workspace_id');
	const workspaceSlug = url.searchParams.get('workspace_slug');
	const workspace = await resolveWorkspace(workspaceId, workspaceSlug);
	let threadQuery = supabaseAdmin
		.from('chat_threads')
		.select('id')
		.eq('user_id', locals.user.id)
		.eq('is_default', true);
	if (workspace?.id) {
		threadQuery = threadQuery.eq('workspace_id', workspace.id);
	} else {
		threadQuery = threadQuery.is('workspace_id', null);
	}
	const { data: thread } = await threadQuery.maybeSingle();
	if (!thread?.id) {
		return json({ thread_id: null, messages: [] }, { status: 200 });
	}
	const { data: messages } = await supabaseAdmin
		.from('chat_messages')
		.select('id, sender, content, created_at')
		.eq('thread_id', thread.id)
		.order('created_at', { ascending: true })
		.limit(50);
	return json(
		{
			thread_id: thread.id,
			messages: (messages ?? []).map(mapMessageToUi)
		},
		{ status: 200 }
	);
};

export const POST = async ({ request, locals }) => {
	if (!SUPABASE_SERVICE_ROLE_KEY) {
		return json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 });
	}
	if (!PUBLIC_SUPABASE_URL) {
		return json({ error: 'Missing PUBLIC_SUPABASE_URL' }, { status: 500 });
	}
	if (!locals?.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const payload = await request.json().catch(() => null);
	const body = {
		...payload,
		user_id: locals.user.id
	};
	const resolvedWorkspace = await resolveWorkspace(
		payload?.workspace_id ?? null,
		payload?.workspace_slug ?? payload?.workspaceSlug ?? null
	);
	if (resolvedWorkspace?.id) {
		body.workspace_id = resolvedWorkspace.id;
		body.workspace_slug =
			resolvedWorkspace.slug ?? payload?.workspace_slug ?? payload?.workspaceSlug;
	}
	if (!body.thread_id) {
		let threadQuery = supabaseAdmin
			.from('chat_threads')
			.select('id')
			.eq('user_id', locals.user.id)
			.eq('is_default', true);
		if (resolvedWorkspace?.id) {
			threadQuery = threadQuery.eq('workspace_id', resolvedWorkspace.id);
		} else {
			threadQuery = threadQuery.is('workspace_id', null);
		}
		const { data: existingThread } = await threadQuery.maybeSingle();
		if (existingThread?.id) {
			body.thread_id = existingThread.id;
		} else {
			const { data: createdThread, error: createError } = await supabaseAdmin
				.from('chat_threads')
				.insert({
					user_id: locals.user.id,
					workspace_id: resolvedWorkspace?.id ?? null,
					is_default: true
				})
				.select('id')
				.single();
			if (createError) {
				return json({ error: createError.message }, { status: 500 });
			}
			if (createdThread?.id) {
				body.thread_id = createdThread.id;
			}
		}
	}

	const wantsStream = request.headers.get('accept')?.includes('text/event-stream');
	const response = await fetch(`${PUBLIC_SUPABASE_URL}/functions/v1/chat`, {
		method: 'POST',
		headers: {
			apikey: SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
			'Content-Type': 'application/json',
			Accept: wantsStream ? 'text/event-stream' : 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (!response.ok) {
		return json({ error: await response.text() }, { status: response.status });
	}

	if (wantsStream) {
		return new Response(response.body, {
			status: response.status,
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive'
			}
		});
	}

	const data = await response.json().catch(() => ({}));
	return json(data, { status: 200 });
};
