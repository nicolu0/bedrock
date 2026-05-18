// draft_vendor — produce a vendor-facing draft for a given issue.
//
// Same shape as draft_tenant: takes { issue_id }, fetches Supabase data,
// fills template, writes draft row with channel='vendor_appfolio'. Human
// reviews + copies into AppFolio.

import { fetchIssueById } from '../supabase.mjs';
import * as db from '../work-orders/state/helpers.mjs';

function renderVendorBody({ issue_summary }) {
	return `Please schedule with the tenant for ${issue_summary}. Their phone number is [phone].`;
}

export const draftVendor = {
	name: 'draft_vendor',
	description:
		'Create a vendor-facing draft message for the given work order. Fills a fixed template using the issue name + recommended vendor. Returns the new draft id. Use this together with draft_tenant when the PM has approved a vendor dispatch.',
	parameters: {
		type: 'object',
		properties: {
			issue_id: {
				type: 'string',
				description: 'The UUID of the work order this draft is for.'
			}
		},
		required: ['issue_id']
	},
	async run({ issue_id }, ctx) {
		const issue = await fetchIssueById(issue_id);
		if (!issue) return { ok: false, error: `issue not found: ${issue_id}` };
		if (!issue.vendor?.name) return { ok: false, error: `issue ${issue_id} has no recommended vendor on file` };

		// issue.name is the work-order title (e.g. "kitchen faucet leaking"),
		// which reads naturally in the template's "for <issue>" slot.
		const summary = issue.name || issue.description || 'this work order';
		const body = renderVendorBody({ issue_summary: summary });

		const draft = await db.createDraft({
			trigger: 'groupchat_reply',
			channel: 'vendor_appfolio',
			workspace_id: issue.workspace_id,
			workspace_label: ctx.workspace_label ?? null,
			issue_id: issue.id,
			to: issue.vendor.name,
			to_participants: [issue.vendor.name],
			messages: [{ body }],
			hold_until: null
		});

		ctx.draftIds = ctx.draftIds ?? [];
		ctx.draftIds.push(draft.id);

		return { ok: true, draft_id: draft.id, channel: 'vendor_appfolio' };
	}
};
