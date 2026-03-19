// @ts-nocheck
import { json } from '@sveltejs/kit';
import { AGENT_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY } from '$env/static/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const agentSecretHeader = 'x-agent-secret';
const pubsubSecretParam = 'secret';

const decodeBase64Url = (input) => {
	const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
	const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
	return Buffer.from(normalized + pad, 'base64').toString('utf-8');
};

const isPubsubSecretValid = (request) => {
	if (!AGENT_WEBHOOK_SECRET) return false;
	const headerSecret = request.headers.get(agentSecretHeader) ?? '';
	const url = new URL(request.url);
	const querySecret = url.searchParams.get(pubsubSecretParam) ?? '';
	return headerSecret === AGENT_WEBHOOK_SECRET || querySecret === AGENT_WEBHOOK_SECRET;
};

const kickAgent = ({ jobId }) => {
	if (!PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
	const url = `${PUBLIC_SUPABASE_URL}/functions/v1/agent`;
	const payload = { job_id: jobId };
	void fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	}).catch((err) => {
		console.error('pubsub-hook kick failed', err);
	});
};

export const POST = async ({ request }) => {
	if (!AGENT_WEBHOOK_SECRET)
		return json({ error: 'Missing AGENT_WEBHOOK_SECRET' }, { status: 500 });
	if (!SUPABASE_SERVICE_ROLE_KEY)
		return json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 });

	const payload = await request.json().catch(() => null);
	if (!payload?.message?.data) {
		return json({ error: 'Missing Pub/Sub message' }, { status: 400 });
	}

	if (!isPubsubSecretValid(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let decoded = null;
	try {
		decoded = decodeBase64Url(payload.message.data);
	} catch (err) {
		console.error('pubsub-hook decode failed', err);
	}
	if (!decoded) {
		return json({ error: 'Invalid Pub/Sub payload' }, { status: 400 });
	}

	let parsed = null;
	try {
		parsed = JSON.parse(decoded);
	} catch (err) {
		console.error('pubsub-hook parse failed', err);
	}
	if (!parsed?.emailAddress || !parsed?.historyId) {
		return json({ error: 'Invalid Pub/Sub payload' }, { status: 400 });
	}

	const email = String(parsed.emailAddress).trim().toLowerCase();
	const historyId = String(parsed.historyId).trim();
	if (!email || !historyId) {
		return json({ error: 'Invalid Pub/Sub payload' }, { status: 400 });
	}

	const { data: jobRow, error: jobError } = await supabaseAdmin
		.from('jobs')
		.insert({
			source: 'gmail',
			payload: { email, history_id: historyId },
			status: 'pending',
			updated_at: new Date().toISOString()
		})
		.select('id')
		.single();

	if (jobError) {
		if (jobError.code === '23505') {
			return json({ status: 'duplicate' }, { status: 200 });
		}
		console.error('pubsub-hook job insert failed', jobError);
		return json({ error: 'Job insert failed' }, { status: 500 });
	}

	if (jobRow?.id) {
		kickAgent({ jobId: jobRow.id });
	}

	return json({ status: 'queued', job_id: jobRow?.id ?? null }, { status: 200 });
};
