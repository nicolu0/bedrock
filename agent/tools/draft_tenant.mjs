// draft_tenant — produce a tenant-facing draft for a given issue.
//
// Takes { issue_id }. Fetches the issue + tenant + vendor from Supabase,
// fills a hardcoded template, and writes a draft row directly to drafts.json
// with channel='tenant_appfolio'. The human reviews + copies into AppFolio.
//
// Phone numbers are not in the schema yet — template uses a [phone] placeholder
// the human fills in before sending.

import { fetchIssueById } from '../core/supabase.mjs';
import * as db from '../state/helpers.mjs';

function renderTenantBody({ tenant_name, vendor_name }) {
	return `Hi ${tenant_name},

I sent this to ${vendor_name}. Please expect a call from [phone]. They will schedule with you.

Best,
Jose`;
}

export const draftTenant = {
	name: 'draft_tenant',
	description:
		'Create a tenant-facing draft message for the given work order. Recipient is always the tenant on the issue. Returns the new draft id. Use this together with draft_vendor when the PM has approved a vendor dispatch. Pass vendor_name when the PM has named a vendor — it appears in the body ("I sent this to {vendor_name}") and overrides whatever vendor is on the issue. Omit vendor_name to fall back to the vendor on the issue row.',
	parameters: {
		type: 'object',
		properties: {
			issue_id: {
				type: 'string',
				description: 'The UUID of the work order this draft is for.'
			},
			vendor_name: {
				type: 'string',
				description:
					'Optional. The vendor to name in the body. Pass this when the PM has named a vendor in their reply (same or different from what we suggested). If omitted, falls back to the vendor on the issue.'
			}
		},
		required: ['issue_id']
	},
	async run({ issue_id, vendor_name }, ctx) {
		const issue = await fetchIssueById(issue_id);
		if (!issue) return { ok: false, error: `issue not found: ${issue_id}` };
		if (!issue.tenant?.name) return { ok: false, error: `issue ${issue_id} has no tenant on file` };

		const vendorName = (vendor_name ?? '').trim() || issue.vendor?.name;
		if (!vendorName)
			return {
				ok: false,
				error: `issue ${issue_id} has no vendor (none on file, none passed via vendor_name)`
			};

		const body = renderTenantBody({
			tenant_name: issue.tenant.name,
			vendor_name: vendorName
		});

		const draft = await db.createDraft({
			trigger: 'groupchat_reply',
			channel: 'tenant_appfolio',
			workspace_id: issue.workspace_id,
			workspace_label: ctx.workspace_label ?? null,
			issue_id: issue.id,
			to: issue.tenant.name,
			to_participants: [issue.tenant.name],
			messages: [{ body }],
			hold_until: null
		});

		// Track for the caller so it can tag the chat-log row with what
		// happened ('drafted' vs 'no_match').
		ctx.draftIds = ctx.draftIds ?? [];
		ctx.draftIds.push(draft.id);

		return { ok: true, draft_id: draft.id, channel: 'tenant_appfolio' };
	}
};
