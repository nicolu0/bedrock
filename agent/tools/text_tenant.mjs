// appfolio_text_tenant — send a free-form text to the tenant on a work order.
//
// The upgrade over draft_tenant: the agent writes the message body itself, so it
// can ask triage questions (request photos, clarify the issue, get a model
// number) instead of being stuck with one hardcoded "a vendor is coming"
// template. The tool still resolves the recipient + (when a vendor is named) the
// vendor's phone, so the agent never has to know or guess a number.
//
// GATING: despite the "Send" framing the agent sees, this still writes a draft
// row (channel='tenant_appfolio') for human review — never auto-sends. The
// always-draft safety lives at the function level here, not in the prompt.

import {
	fetchIssueById,
	fetchVendorByName,
	fetchWorkspaceVendors,
	formatPhone
} from '../core/supabase.mjs';
import { shortenVendorName, firstName } from '../core/names.mjs';
import * as db from '../state/helpers.mjs';

// Keep the formal tenant wrapper on the tool side (greeting + signature) so the
// agent only writes the substance and tenant comms stay uniform. A vendor
// contact line is appended only when a vendor is named (and has a phone on file
// — no placeholder leaks).
function renderTenantBody({ tenant_name, body, vendor_name, vendor_phone }) {
	const lines = [`Hi ${tenant_name},`, '', body.trim()];
	if (vendor_name) {
		const at = vendor_phone ? ` at ${vendor_phone}` : '';
		lines.push('', `${vendor_name} can be reached${at}.`);
	}
	lines.push('', 'Best,', 'Jose');
	return lines.join('\n');
}

export const textTenant = {
	name: 'appfolio_text_tenant',
	description:
		'Send a free-form text to the tenant on a work order. Use it to ask the ' +
		'tenant questions during triage (request photos, clarify the issue, get a ' +
		'model number) OR to notify them a vendor was dispatched. You write the ' +
		'message body in your own words; the greeting ("Hi {name},") and signature ' +
		'("Best, Jose") are added for you, so write only the substance. Pass ' +
		'vendor_name on a dispatch notification to append the vendor\'s phone — ' +
		'never hand-type a phone number. Recipient is always the tenant on the issue.',
	parameters: {
		type: 'object',
		properties: {
			issue_id: {
				type: 'string',
				description: 'The UUID of the work order this message is for.'
			},
			body: {
				type: 'string',
				description:
					'The message to the tenant, in your own words — the substance only. Do NOT include a greeting or sign-off; those are added for you. Keep it formal (this goes to the tenant, not the PM).'
			},
			vendor_name: {
				type: 'string',
				description:
					'Optional. Pass only when notifying the tenant a vendor was dispatched. The tool resolves that vendor\'s phone and appends a contact line. Omit it for triage questions.'
			}
		},
		required: ['issue_id', 'body']
	},
	async run({ issue_id, body, vendor_name }, ctx) {
		const issue = await fetchIssueById(issue_id);
		if (!issue) return { ok: false, error: `issue not found: ${issue_id}` };
		if (!issue.tenant?.name) return { ok: false, error: `issue ${issue_id} has no tenant on file` };
		if (!body || !body.trim()) return { ok: false, error: 'body is required' };

		// Resolve the vendor's phone only when a vendor is named. An override that
		// names the vendor already on the issue → use the joined row; a genuine
		// override → look it up by name so we don't quote the wrong number.
		let vendorDisplay = null;
		let vendorPhone = null;
		const override = (vendor_name ?? '').trim();
		if (override) {
			const sameAsIssue =
				issue.vendor?.name && override.toLowerCase() === issue.vendor.name.toLowerCase();
			if (sameAsIssue) {
				vendorPhone = issue.vendor?.phone ?? null;
			} else {
				const match = await fetchVendorByName(issue.workspace_id, override);
				vendorPhone = match?.phone ?? null;
			}
			const roster = await fetchWorkspaceVendors(issue.workspace_id);
			vendorDisplay = shortenVendorName(override, roster);
		}

		const renderedBody = renderTenantBody({
			tenant_name: firstName(issue.tenant.name),
			body,
			vendor_name: vendorDisplay,
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
			messages: [{ body: renderedBody }],
			hold_until: null
		});

		// Track for the caller so it can tag the chat-log row with what happened.
		ctx.draftIds = ctx.draftIds ?? [];
		ctx.draftIds.push(draft.id);

		return { ok: true, draft_id: draft.id, channel: 'tenant_appfolio' };
	}
};
