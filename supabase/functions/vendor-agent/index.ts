// @ts-nocheck
// V2 vendor agent. Reads issues_v2.description + workspace vendors +
// owner_notes for the property + RELEVANT BELIEFS from the memory graph, asks
// OpenAI to pick a single best vendor, writes vendor_id.
//
// Beliefs are read via the match_beliefs RPC (vector similarity over the
// claim text) and injected as a "Known preferences" block in the system
// prompt. Owner notes still win on conflict — they're the human's most
// recent direct expression of intent. PR #3 will migrate owner_notes into
// beliefs and remove the redundant read.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { claimAgentRun, completeAgentRun, failAgentRun } from '../_shared/agent-runs.ts';
import { recallBeliefs, formatBeliefsBlock, type BeliefRow } from '../_shared/beliefs.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!;
const OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false, autoRefreshToken: false }
});

type Vendor = { id: string; name: string; trade: string | null; note: string | null };

async function pickVendor(
	description: string,
	vendors: Vendor[],
	ownerNotes: string[],
	beliefs: BeliefRow[]
): Promise<{ vendorId: string | null; reason: string }> {
	if (!vendors.length) return { vendorId: null, reason: 'no vendors in workspace' };

	const vendorList = vendors
		.map((v, i) => `${i + 1}. ${v.name}${v.trade ? ` (${v.trade})` : ''}${v.note ? ` — note: ${v.note}` : ''}`)
		.join('\n');

	const beliefsBlock = beliefs.length
		? `\n\nKnown preferences (the property manager has told us these — honor unless an owner note overrides):\n${formatBeliefsBlock(beliefs)}`
		: '';

	const notesBlock = ownerNotes.length
		? `\n\nOwner/property notes (highest authority — follow strictly):\n${ownerNotes.map((n) => `- ${n}`).join('\n')}`
		: '';

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${OPENAI_API_KEY}`
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content:
						'You select a single best vendor for a property maintenance work order. ' +
						'Return JSON: { "vendor_index": <1-based index from the vendor list>, "reason": "<brief>" }. ' +
						'Priority order:\n' +
						'1. Owner/property notes are highest authority — if a note specifies a vendor for this kind of work, pick that vendor.\n' +
						'2. Known preferences (beliefs) are next — if a preference matches the work order scope (property, trade), pick that vendor. Prefer more specific scope (property-specific over general) and higher confidence.\n' +
						'3. Vendor "note" fields are instructions; follow them.\n' +
						'4. Otherwise: prefer a handyman for simple repairs (battery swap, minor fixes, general maintenance); pick a specialist (plumber, electrician, HVAC) only when the work clearly requires licensed trade work.\n' +
						'Always pick exactly one. Use the vendor_index of your pick (1-based). The reason field should cite which preference or note drove the choice when applicable.'
				},
				{
					role: 'user',
					content: `Work order:\n${description}\n\nAvailable vendors:\n${vendorList}${beliefsBlock}${notesBlock}`
				}
			]
		})
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
	}
	const json = await res.json();
	const content = json.choices?.[0]?.message?.content ?? '{}';
	const parsed = JSON.parse(content);
	const idx = Number(parsed.vendor_index);
	const vendor = Number.isFinite(idx) && idx >= 1 && idx <= vendors.length ? vendors[idx - 1] : null;
	return {
		vendorId: vendor?.id ?? null,
		reason: String(parsed.reason ?? '').slice(0, 200)
	};
}

serve(async (req) => {
	const { issueId } = await req.json();
	if (!issueId) return Response.json({ ok: false, error: 'Missing issueId' }, { status: 400 });

	const runId = await claimAgentRun(supabase, issueId, 'vendor');
	if (!runId) {
		console.log(`vendor-agent: ${issueId} already claimed or done, skipping`);
		return Response.json({ ok: true, skipped: true });
	}

	console.log(`vendor-agent: ${issueId} run=${runId}`);

	try {
		const { data: issue, error: fetchErr } = await supabase
			.from('issues_v2')
			.select('id, workspace_id, property_id, description, property:properties!property_id(name)')
			.eq('id', issueId)
			.maybeSingle();
		if (fetchErr) throw new Error(`fetch issue: ${fetchErr.message}`);
		if (!issue) throw new Error(`issue ${issueId} not found`);
		if (!issue.description) throw new Error(`issue ${issueId} has no description`);

		const { data: vendors } = await supabase
			.from('vendors')
			.select('id, name, trade, note')
			.eq('workspace_id', issue.workspace_id)
			.order('preference_index', { ascending: true })
			.limit(50);

		const ownerNotes: string[] = [];
		if (issue.property_id) {
			const { data: noteRows } = await supabase
				.from('owner_notes')
				.select('content')
				.eq('workspace_id', issue.workspace_id)
				.eq('property_id', issue.property_id);
			(noteRows ?? []).forEach((r: any) => ownerNotes.push(r.content));
		}

		// Query the belief graph. The query string mixes the work-order
		// description with the property name when present, so property-scoped
		// beliefs surface alongside generic-plumbing ones.
		const propertyName = (issue as any).property?.name ?? null;
		const beliefQuery = propertyName
			? `${issue.description} at ${propertyName}`
			: issue.description;
		let beliefs: BeliefRow[] = [];
		try {
			beliefs = await recallBeliefs(supabase, OPENAI_API_KEY, {
				workspaceId: issue.workspace_id,
				query: beliefQuery,
				topK: 8,
				confidenceFloor: 0.4
			});
		} catch (err) {
			// Belief recall failure shouldn't block dispatch — log and continue
			// without the preferences block.
			console.error(`vendor-agent: belief recall failed for ${issueId}:`, err);
		}

		const { vendorId, reason } = await pickVendor(
			issue.description,
			(vendors ?? []) as Vendor[],
			ownerNotes,
			beliefs
		);

		if (vendorId) {
			const { error: updateErr } = await supabase
				.from('issues_v2')
				.update({ vendor_id: vendorId })
				.eq('id', issueId);
			if (updateErr) throw new Error(`update issue: ${updateErr.message}`);
		}

		await completeAgentRun(supabase, issueId, 'vendor');
		console.log(
			`vendor-agent: ${issueId} done — vendor=${vendorId ?? 'none'} beliefs=${beliefs.length} owner_notes=${ownerNotes.length} reason="${reason}"`
		);
		return Response.json({ ok: true, issueId, vendorId, reason, beliefs_used: beliefs.length });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`vendor-agent: ${issueId} failed:`, message);
		await failAgentRun(supabase, issueId, 'vendor', err);
		return Response.json({ ok: false, error: message }, { status: 500 });
	}
});
