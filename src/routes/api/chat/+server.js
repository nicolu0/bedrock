// @ts-nocheck
import { json } from '@sveltejs/kit';
import { SUPABASE_SERVICE_ROLE_KEY } from '$env/static/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';

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
