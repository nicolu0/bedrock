// set_vendor — write the agent's vendor pick back to the issues_v2 row.
// Called by process_wo after read_memory + ranking. The vendor_id powers the
// dashboard's "recommended vendor" column and downstream draft_vendor.

import { supabaseEnv } from '../core/supabase.mjs';

export const setVendor = {
	name: 'set_vendor',
	description:
		'Persist the vendor you picked for this work order. Call after read_memory + reasoning, before send_text. vendor_id is the UUID from a read_memory candidate (kind=vendor) or from the inline candidate list in the work-order context. If you have no candidate confident enough to pick, do NOT call this tool — send a single message without naming a vendor.',
	parameters: {
		type: 'object',
		additionalProperties: false,
		required: ['issue_id', 'vendor_id'],
		properties: {
			issue_id: { type: 'string', description: 'UUID of the issues_v2 row.' },
			vendor_id: { type: 'string', description: 'UUID of the vendors row you picked.' }
		}
	},
	async run({ issue_id, vendor_id }, _ctx) {
		// Eval mode: short-circuit so we never hit Supabase. The suite asserts
		// the tool was CALLED — not what landed in the DB.
		if (process.env.BEDROCK_EVAL_MODE === '1') {
			return { ok: true, issue_id, vendor_id, eval_mode: true };
		}

		const { url, key } = supabaseEnv();
		const res = await fetch(
			`${url}/rest/v1/issues_v2?id=eq.${encodeURIComponent(issue_id)}`,
			{
				method: 'PATCH',
				headers: {
					apikey: key,
					Authorization: `Bearer ${key}`,
					'Content-Type': 'application/json',
					Prefer: 'return=representation'
				},
				body: JSON.stringify({ vendor_id })
			}
		);
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			return { ok: false, error: `set_vendor PATCH ${res.status}: ${detail.slice(0, 200)}` };
		}
		const rows = await res.json();
		if (!rows.length) return { ok: false, error: `set_vendor: no row matched id=${issue_id}` };
		return { ok: true, issue_id, vendor_id };
	}
};
