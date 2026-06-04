// draft_vendor — produce a vendor-facing draft for a given issue.
//
// Same shape as draft_tenant: takes { issue_id }, fetches Supabase data,
// fills template, writes draft row with channel='vendor_appfolio'. Human
// reviews + copies into AppFolio.

import {
	fetchIssueById,
	fetchUnitTenantPhone,
	fetchWorkspaceVendors,
	formatPhone
} from '../core/supabase.mjs';
import { shortenVendorName, lowerLead } from '../core/names.mjs';
import * as db from '../state/helpers.mjs';

function renderVendorBody({ issue_summary, tenant_phone }) {
	const phone = tenant_phone ? ` Their phone number is ${tenant_phone}.` : '';
	// lowerLead: the title lands mid-sentence ("for dead outlets"), so drop its
	// leading capital — but leave acronyms ("AC ...") alone.
	return `Please schedule with the tenant for ${lowerLead(issue_summary)}.${phone}`;
}

export const draftVendor = {
	name: 'draft_vendor',
	description:
		'Create a vendor-facing draft message for the given work order. Returns the new draft id. Use this together with draft_tenant when the PM has approved a vendor dispatch. Pass vendor_name when the PM has named a vendor — it overrides whatever vendor is on the issue (use this for vendor swaps like "send Luigi" or "no send Luigi instead"). Omit vendor_name to fall back to the vendor on the issue row.',
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
					'Optional. The vendor to address this draft to. Pass this when the PM has named a vendor in their reply (same or different from what we suggested). If omitted, falls back to the vendor on the issue.'
			}
		},
		required: ['issue_id']
	},
	async run({ issue_id, vendor_name }, ctx) {
		const issue = await fetchIssueById(issue_id);
		if (!issue) return { ok: false, error: `issue not found: ${issue_id}` };

		const rawVendorName = (vendor_name ?? '').trim() || issue.vendor?.name;
		if (!rawVendorName)
			return {
				ok: false,
				error: `issue ${issue_id} has no vendor (none on file, none passed via vendor_name)`
			};

		// Address the vendor the way the PM does — first name / short name —
		// resolving first-name collisions against the workspace roster.
		const roster = await fetchWorkspaceVendors(issue.workspace_id);
		const vendorName = shortenVendorName(rawVendorName, roster);

		// issue.name is the work-order title (e.g. "kitchen faucet leaking"),
		// which reads naturally in the template's "for <issue>" slot.
		const summary = issue.name || issue.description || 'this work order';

		// The vendor needs a number to call. Prefer the issue's tenant; if that
		// tenant has no phone (common for co-tenants), fall back to any unit-mate
		// with one so the draft still carries a reachable number.
		let tenantPhone = issue.tenant?.phone ?? null;
		if (!tenantPhone && issue.unit_id) {
			tenantPhone = await fetchUnitTenantPhone(issue.unit_id, { excludeName: issue.tenant?.name });
		}

		const body = renderVendorBody({
			issue_summary: summary,
			tenant_phone: formatPhone(tenantPhone)
		});

		const draft = await db.createDraft({
			trigger: 'groupchat_reply',
			channel: 'vendor_appfolio',
			workspace_id: issue.workspace_id,
			workspace_label: ctx.workspace_label ?? null,
			issue_id: issue.id,
			to: vendorName,
			to_participants: [vendorName],
			messages: [{ body }],
			hold_until: null
		});

		ctx.draftIds = ctx.draftIds ?? [];
		ctx.draftIds.push(draft.id);

		return { ok: true, draft_id: draft.id, channel: 'vendor_appfolio' };
	}
};
