// @ts-nocheck
import { error, redirect } from '@sveltejs/kit';
import { encodePathSegment } from '$lib/utils/url.js';

// Back-compat for old links where `readableId` contained an unencoded `/`.
// Example:
//   /lapm/issue/464-4645%201/2-139/roach-treatment
// becomes:
//   /lapm/issue/464-4645%201%2F2-139/roach-treatment
export const load = ({ params, url }) => {
	const raw = params.issue_path ?? '';
	const parts = raw.split('/').filter(Boolean);
	if (parts.length < 2) throw error(404, 'Not found');

	const issueName = parts[parts.length - 1];
	const issueId = parts.slice(0, -1).join('/');

	const dest = `/${params.workspace}/issue/${encodePathSegment(issueId)}/${encodePathSegment(issueName)}${url.search}`;
	throw redirect(308, dest);
};
