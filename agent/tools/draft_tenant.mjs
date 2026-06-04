// draft_tenant — produce a tenant-facing draft for a given issue.
//
// Takes { issue_id }. Fetches the issue + tenant + vendor from Supabase,
// fills a hardcoded template, and writes a draft row directly to drafts.json
// with channel='tenant_appfolio'. The human reviews + copies into AppFolio.
//
// The tenant message tells the tenant who to expect a call from — so it carries
// the VENDOR's phone. We read it from the issue's vendor join, or (when the PM
// names an override vendor) look that vendor up by name. If no number is on
// file the phone clause is dropped rather than leaking a placeholder.

import {
	fetchIssueById,
	fetchVendorByName,
	fetchWorkspaceVendors,
	formatPhone
} from '../core/supabase.mjs';
import { shortenVendorName, firstName } from '../core/names.mjs';
import * as db from '../state/helpers.mjs';

function renderTenantBody({ tenant_name, vendor_name, vendor_phone }) {
	const at = vendor_phone ? ` at ${vendor_phone}` : '';
	return `Hi ${tenant_name},

I sent this to ${vendor_name}. Please expect a call from them${at}. They will schedule with you.

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

		const override = (vendor_name ?? '').trim();
		const vendorName = override || issue.vendor?.name;
		if (!vendorName)
			return {
				ok: false,
				error: `issue ${issue_id} has no vendor (none on file, none passed via vendor_name)`
			};

		// Resolve the vendor's phone. No override (or override names the same
		// vendor that's on the issue) → use the joined row. A genuine override →
		// look that vendor up by name so we don't quote the wrong number.
		let vendorPhone = null;
		const sameAsIssue =
			issue.vendor?.name && override.toLowerCase() === issue.vendor.name.toLowerCase();
		if (!override || sameAsIssue) {
			vendorPhone = issue.vendor?.phone ?? null;
		} else {
			const match = await fetchVendorByName(issue.workspace_id, override);
			vendorPhone = match?.phone ?? null;
		}

		// Name the vendor the way the PM does in the tenant-facing message. Keep
		// the raw name above for phone resolution; shorten only for display.
		const roster = await fetchWorkspaceVendors(issue.workspace_id);
		const body = renderTenantBody({
			tenant_name: firstName(issue.tenant.name),
			vendor_name: shortenVendorName(vendorName, roster),
			vendor_phone: formatPhone(vendorPhone)
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
