// @ts-nocheck
import { json, error } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { notifyFoundersOfAppfolioAction } from '$lib/server/notifications';

export const POST = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const { issueId, action, meta = {} } = body ?? {};

	if (!issueId || !action) throw error(400, 'issueId and action are required');

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('id, name, source, appfolio_id, readable_id')
		.eq('id', issueId)
		.maybeSingle();

	if (!issue) throw error(404, 'Issue not found');
	if (issue.source !== 'appfolio') return json({ skipped: true });

	const TITLES = {
		vendor_assign: `AppFolio action needed: vendor assigned on ${issue.readable_id ?? issue.name}`,
		status_change: `AppFolio action needed: status changed on ${issue.readable_id ?? issue.name}`
	};
	const BODIES = {
		vendor_assign: `Vendor "${meta.vendorName ?? 'unknown'}" was assigned in Bedrock for work order ${issue.appfolio_id ?? issue.readable_id}. Please update vendor assignment in AppFolio.`,
		status_change: `Status was changed to "${meta.status ?? 'unknown'}" in Bedrock for work order ${issue.appfolio_id ?? issue.readable_id}. Please update status in AppFolio.`
	};

	await notifyFoundersOfAppfolioAction({
		issue,
		action,
		title: TITLES[action] ?? `AppFolio action needed on ${issue.readable_id ?? issue.name}`,
		body: BODIES[action] ?? `Action "${action}" taken in Bedrock — please update AppFolio.`,
		meta
	});

	return json({ ok: true });
};
