// update_issue — the agent's general write path into a work-order record.
//
// Generalizes set_vendor: instead of one tool per column, this patches a
// whitelisted set of fields on issues_v2. Its main job is advancing the work
// order's lifecycle `status` as the agent works the order — every PM reply
// should move a WO out of `awaiting_pm` so answered orders stop resurfacing as
// phantom candidates. It can also set the recommended vendor (replacing the old
// set_vendor call) and leave a short free-text status_reason.
//
// The status enum is enforced twice: the JSON-schema `enum` constrains the
// model, and the DB's issues_v2_status_check rejects anything off-list.

import { patchIssue } from '../core/supabase.mjs';

// Single source of truth for the lifecycle states + their meaning. Surfaced to
// the model in the status param description so it always sees the options and a
// gloss for each. Keep in sync with the issues_v2_status_check constraint.
export const ISSUE_STATUSES = [
	'new',
	'triaging',
	'awaiting_pm',
	'dispatched',
	'scheduled',
	'pm_handling',
	'completed'
];

const STATUS_GLOSS = [
	'The work order lifecycle state. Pick the one that matches what just happened:',
	'- new: just landed, not yet surfaced to the PM.',
	'- triaging: gathering info from the tenant — a vague WO, or the PM asked for a photo / model number / more detail before deciding.',
	'- awaiting_pm: you texted the PM a summary and are waiting on their go-ahead. This is the ONLY state that counts as an open candidate the PM could be replying to.',
	'- dispatched: the PM approved and you contacted the vendor/tenant; no confirmed appointment time yet.',
	'- scheduled: an appointment is on the books, awaiting the work.',
	"- pm_handling: the PM took it off your plate — self-handled ('I already took care of those'), deferred to the owner, or declined. Terminal for the agent.",
	'- completed: the work is confirmed done. Terminal.'
].join('\n');

export const updateIssue = {
	name: 'update_issue',
	description:
		"Update a work order's record on issues_v2. Use it to advance the lifecycle `status` (the main use — move a WO forward as you act on the PM's reply), set the recommended `vendor_id`, and/or leave a short `status_reason`. Pass issue_id plus at least one field to change. Setting status stamps status_updated_at automatically.",
	parameters: {
		type: 'object',
		additionalProperties: false,
		required: ['issue_id'],
		properties: {
			issue_id: { type: 'string', description: 'UUID of the issues_v2 row.' },
			status: {
				type: 'string',
				enum: ISSUE_STATUSES,
				description: STATUS_GLOSS
			},
			status_reason: {
				type: 'string',
				description:
					"Short free-text note explaining the status, e.g. 'Jose handling directly', 'waiting on tenant photo', 'overrode to Luigi'. Optional."
			},
			vendor_id: {
				type: 'string',
				description:
					'UUID of the vendors row to set as the recommended/assigned vendor (the UUID from a read_memory candidate or the inline candidate list). Replaces the old set_vendor call.'
			}
		}
	},
	async run({ issue_id, status, status_reason, vendor_id }, _ctx) {
		if (!issue_id) return { ok: false, error: 'update_issue: issue_id required' };

		const patch = {};
		if (status !== undefined) {
			patch.status = status;
			patch.status_updated_at = new Date().toISOString();
		}
		if (status_reason !== undefined) patch.status_reason = status_reason;
		if (vendor_id !== undefined) patch.vendor_id = vendor_id;

		if (Object.keys(patch).length === 0) {
			return {
				ok: false,
				error: 'update_issue: pass at least one of status, status_reason, vendor_id'
			};
		}

		// Eval mode: never hit Supabase. The suite asserts the tool was CALLED with
		// the right args — not what landed in the DB.
		if (process.env.BEDROCK_EVAL_MODE === '1') {
			return { ok: true, issue_id, ...patch, eval_mode: true };
		}

		try {
			const row = await patchIssue(issue_id, patch);
			if (!row) return { ok: false, error: `update_issue: no row matched id=${issue_id}` };
			return { ok: true, issue_id, ...patch };
		} catch (err) {
			return { ok: false, error: err.message };
		}
	}
};
