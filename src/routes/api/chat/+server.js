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

export const GET = async ({ locals }) => {
	if (!locals?.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const { data: thread } = await supabaseAdmin
		.from('chat_threads')
		.select('id')
		.eq('user_id', locals.user.id)
		.eq('is_default', true)
		.maybeSingle();
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

	const response = await fetch(`${PUBLIC_SUPABASE_URL}/functions/v1/chat`, {
		method: 'POST',
		headers: {
			apikey: SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (!response.ok) {
		return json({ error: await response.text() }, { status: response.status });
	}

	const data = await response.json().catch(() => ({}));
	return json(data, { status: 200 });
};
