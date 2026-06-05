// text_tenant — message the tenant on a work order. Two modes, chosen by whether
// `body` is present:
//
//   • TRIAGE (pass `body`): the agent writes a free-form question to the tenant
//     to triage the issue — ask for a photo, a model number, clarify the
//     problem. This is the new capability: before this the agent physically
//     could not put a question in front of the tenant. The body should name the
//     issue for context ("For the garbage disposal you reported, …").
//
//   • DISPATCH (omit `body`): the templated "a vendor is coming" notification —
//     unchanged from draft_tenant. Resolves the vendor's phone and tells the
//     tenant to expect a call. Pass `vendor_name` to override the issue's vendor.
//
// Either way the message is formal and signed "Best, Jose" — no "Hi {name},"
// greeting (product decision).
//
// PMS-AGNOSTIC: the draft channel is tenant_<pms> via pmsFor() (tenant_appfolio
// today). Plug a workspace into another PMS by setting its `pms` in
// core/workspaces.mjs — no tool change.
//
// GATING: despite the "send" framing the agent sees, this always writes a draft
// for human review — it never sends to the PMS / tenant directly. The
// always-draft safety lives at the function level here, not in the prompt.

import {
	fetchIssueById,
	fetchVendorByName,
	fetchWorkspaceVendors,
	formatPhone
} from '../core/supabase.mjs';
import { pmsFor } from '../core/workspaces.mjs';
import { shortenVendorName } from '../core/names.mjs';
import * as db from '../state/helpers.mjs';

// Formal tenant signature, kept tool-side so tenant comms stay uniform and the
// agent only ever writes the substance. No greeting line.
function sign(bodyText) {
	return `${bodyText.trim()}\n\nBest,\nJose`;
}

// The dispatch notification — same wording as the old draft_tenant, minus the
// greeting. Drops the phone clause if none is on file (no placeholder leak).
function renderDispatchBody({ vendor_name, vendor_phone }) {
	const at = vendor_phone ? ` at ${vendor_phone}` : '';
	return sign(
		`I sent this to ${vendor_name}. Please expect a call from them${at}. They will schedule with you.`
	);
}

export const textTenant = {
	name: 'text_tenant',
	description:
		'Message the tenant on a work order. TWO uses, picked by whether you pass `body`:\n' +
		'(1) Triage question — pass `body` to ask the tenant something in your own words ' +
		'(request a photo, a model number, clarify the problem). Name the issue for ' +
		'context, e.g. "For the broken garbage disposal you reported, could you send a ' +
		'photo of the unit underneath?".\n' +
		'(2) Vendor-dispatch notification — OMIT `body` and the tool sends the standard ' +
		'"a vendor is coming, expect a call at {phone}" message; pass `vendor_name` only to ' +
		'override the vendor on the issue.\n' +
		'The "Best, Jose" signature is added for you — write only the substance, formally ' +
		'(this goes to the tenant, not the PM). Recipient is always the tenant on the issue. ' +
		'Always staged as a draft for human review — never auto-sent.',
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
					'Triage mode. The question to the tenant, in your own words — the substance only, no greeting or sign-off. ALWAYS open by naming the issue they reported so they know which request it is about — start with "For the {issue} you reported, …", then ask. Omit this to send the vendor-dispatch notification instead.'
			},
			vendor_name: {
				type: 'string',
				description:
					'Dispatch mode only (used when `body` is omitted). The vendor to name; the tool resolves their phone. Omit to fall back to the vendor on the issue. Ignored when `body` is set.'
			}
		},
		required: ['issue_id']
	},
	async run({ issue_id, body, vendor_name }, ctx) {
		const issue = await fetchIssueById(issue_id);
		if (!issue) return { ok: false, error: `issue not found: ${issue_id}` };
		if (!issue.tenant?.name) return { ok: false, error: `issue ${issue_id} has no tenant on file` };

		const triage = Boolean(body && body.trim());
		let renderedBody;

		if (triage) {
			// Free-form triage question — the agent wrote the substance.
			renderedBody = sign(body);
		} else {
			// Dispatch notification — templated, resolves the vendor's phone. Same
			// behavior as the old draft_tenant: vendor_name overrides the issue's
			// vendor; without it we fall back to the vendor on the issue row.
			const override = (vendor_name ?? '').trim();
			const vendorName = override || issue.vendor?.name;
			if (!vendorName)
				return {
					ok: false,
					error: `issue ${issue_id}: pass a body (triage question) or a vendor (none on file, none passed via vendor_name)`
				};

			// No override (or it names the vendor already on the issue) → use the
			// joined row; a genuine override → look it up so we don't quote the
			// wrong number.
			let vendorPhone = null;
			const sameAsIssue =
				issue.vendor?.name && override.toLowerCase() === issue.vendor.name.toLowerCase();
			if (!override || sameAsIssue) {
				vendorPhone = issue.vendor?.phone ?? null;
			} else {
				const match = await fetchVendorByName(issue.workspace_id, override);
				vendorPhone = match?.phone ?? null;
			}

			const roster = await fetchWorkspaceVendors(issue.workspace_id);
			renderedBody = renderDispatchBody({
				vendor_name: shortenVendorName(vendorName, roster),
				vendor_phone: formatPhone(vendorPhone)
			});
		}

		// Resolve the workspace's PMS so the draft is tagged for the right send
		// surface. channel stays tenant_appfolio for AppFolio workspaces (back-compat
		// with the followup/runner consumers); flips automatically for any other PMS.
		const pms = pmsFor(issue.workspace_id);
		const channel = `tenant_${pms}`;

		const draft = await db.createDraft({
			trigger: 'groupchat_reply',
			channel,
			pms,
			// A triage question is mid-conversation info-gathering, NOT a dispatch —
			// the human reviewer (and candidate-list filtering) treats it differently
			// from the "a vendor is coming" notice. See alreadyDispatchedIssueIds.
			triage,
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

		return { ok: true, draft_id: draft.id, channel, mode: triage ? 'triage' : 'dispatch' };
	}
};
