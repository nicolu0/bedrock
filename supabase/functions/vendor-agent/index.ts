// @ts-nocheck
// V2 vendor agent. Reads issues_v2.description + workspace vendors +
// RELEVANT BELIEFS from the memory graph, asks OpenAI to pick a single best
// vendor, writes vendor_id.
//
// Beliefs are read via the match_beliefs RPC (vector similarity over the
// claim text) and injected as a "Known preferences" block in the system
// prompt. They are now the single source of truth for PM preferences;
// owner_notes, vendor.note, and workspace_policies were dropped in PR #3.
//
// Auth: verify_jwt is disabled (see ./config.json). vendor-agent is
// internal-only, invoked by intake-agent over the supabase URL. The old
// internal_agent_key gate was removed in b8f00fa; we accept that this URL is
// effectively public and rely on the fact that an attacker would need a valid
// issueId UUID to do anything (and the worst-case is a vendor reassignment,
// no data exposure).

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

type Vendor = { id: string; name: string; trade: string | null };

async function pickVendor(
	description: string,
	vendors: Vendor[],
	beliefs: BeliefRow[]
): Promise<{ vendorId: string | null; reason: string }> {
	if (!vendors.length) return { vendorId: null, reason: 'no vendors in workspace' };

	const vendorList = vendors
		.map((v) => `- ${v.name}${v.trade ? ` (${v.trade})` : ''}`)
		.join('\n');

	const beliefsBlock = beliefs.length
		? `\n\nKnown preferences (the property manager has told us these — honor when scope matches):\n${formatBeliefsBlock(beliefs)}`
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
						'Return JSON: { "vendor_name": "<exact name from the vendor list, copied verbatim>", "reason": "<brief>" }. ' +
						'Copy the vendor name EXACTLY as it appears — character for character. Do not abbreviate, reorder, or add words.\n' +
						'Apply these rules in STRICT priority order. A higher-priority rule always overrides a lower one.\n' +
						'1. Known preferences (beliefs from the property manager): if a belief\'s scope matches the work order (same property and/or same trade/problem), pick the vendor the belief names. A more specific belief (property + trade) overrides a less specific one.\n' +
						'2. Otherwise: match by trade. Prefer a handyman for simple repairs (battery swap, minor fixes, general maintenance); pick a specialist (plumber, electrician, HVAC, appliance) only when licensed trade work is required.\n' +
						'In the "reason" field, name the rule you applied (e.g. "belief: use Mario for dryers at Hub Champaign" or "trade match: appliance specialist for a leaking washing machine"). If you saw a matching belief and did NOT follow it, you must explain why.'
				},
				{
					role: 'user',
					content: `Work order:\n${description}\n\nAvailable vendors:\n${vendorList}${beliefsBlock}`
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
	const pickedName = String(parsed.vendor_name ?? '').trim();
	const norm = (s: string) => s.toLowerCase().replace(/[\s.,'"-]+/g, ' ').trim();
	const npicked = norm(pickedName);
	// Longest match wins so "Mario, the onsite manager" doesn't accidentally
	// match a vendor named "Mario" when a longer-named vendor is also a prefix.
	const sortedByName = [...vendors].sort((a, b) => b.name.length - a.name.length);
	const vendor = vendors.find((v) => v.name === pickedName)
		?? vendors.find((v) => v.name.toLowerCase() === pickedName.toLowerCase())
		?? sortedByName.find((v) => norm(v.name) === npicked)
		// Loose: picked text contains the vendor name as a token sequence at
		// the start (e.g. "Mario, the onsite manager" -> "Mario").
		?? sortedByName.find((v) => npicked.startsWith(norm(v.name) + ' '))
		?? sortedByName.find((v) => npicked === norm(v.name));
	if (!vendor && pickedName) {
		console.warn(`vendor-agent: model returned vendor_name "${pickedName}" not in list`);
	}
	console.log(`vendor-agent: picked_name="${pickedName}" -> vendor=${vendor?.name ?? 'NONE'}`);
	return {
		vendorId: vendor?.id ?? null,
		reason: String(parsed.reason ?? '').slice(0, 200),
		pickedName
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
			.select('id, name, trade')
			.eq('workspace_id', issue.workspace_id)
			.order('preference_index', { ascending: true })
			.limit(50);

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

		const { vendorId, reason, pickedName } = await pickVendor(
			issue.description,
			(vendors ?? []) as Vendor[],
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
			`vendor-agent: ${issueId} done — vendor=${vendorId ?? 'none'} beliefs=${beliefs.length} reason="${reason}"`
		);
		return Response.json({ ok: true, issueId, vendorId, reason, beliefs_used: beliefs.length, picked_name: pickedName });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`vendor-agent: ${issueId} failed:`, message);
		await failAgentRun(supabase, issueId, 'vendor', err);
		return Response.json({ ok: false, error: message }, { status: 500 });
	}
});
