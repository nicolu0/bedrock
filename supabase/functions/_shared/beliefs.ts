// Deno-side belief recall for edge functions. Mirrors the shape of
// agent/core/memory.mjs#recallBeliefs but uses the SupabaseClient passed in.
//
// One query = one embed + one match_beliefs RPC. Results are belief rows
// ordered by similarity DESC, filtered by similarity_floor and (optionally) a
// confidence floor on the caller side.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const EMBEDDING_MODEL = 'text-embedding-3-small';

export type BeliefRow = {
	id: string;
	workspace_id: string;
	claim: string;
	scope: Record<string, unknown>;
	confidence: number;
	explicitness: 'stated' | 'inferred';
	created_by: 'agent' | 'user';
	created_at: string;
	updated_at: string;
	tags: string[];
	similarity: number;
};

export async function embedQuery(openaiKey: string, text: string): Promise<number[]> {
	const res = await fetch('https://api.openai.com/v1/embeddings', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
		body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.trim() })
	});
	if (!res.ok) throw new Error(`embed: ${res.status} ${(await res.text()).slice(0, 200)}`);
	const body = await res.json();
	const vec = body?.data?.[0]?.embedding;
	if (!Array.isArray(vec)) throw new Error('embed: missing vector in response');
	return vec;
}

export type RecallOpts = {
	workspaceId: string;
	query: string;
	topK?: number;
	similarityFloor?: number;
	confidenceFloor?: number;
};

export async function recallBeliefs(
	supabase: SupabaseClient,
	openaiKey: string,
	opts: RecallOpts
): Promise<BeliefRow[]> {
	const { workspaceId, query, topK = 8, similarityFloor = 0.3, confidenceFloor = 0.4 } = opts;
	if (!query.trim()) return [];
	const embedding = await embedQuery(openaiKey, query);
	const { data, error } = await supabase.rpc('match_beliefs', {
		query_embedding: embedding,
		workspace_id_in: workspaceId,
		match_count: topK,
		similarity_floor: similarityFloor
	});
	if (error) throw new Error(`match_beliefs: ${error.message}`);
	const rows = (data ?? []) as BeliefRow[];
	return rows.filter((b) => b.confidence >= confidenceFloor);
}

// Format beliefs for injection into an LLM system prompt. Each line is
// self-contained — claim plus a short tail with confidence/explicitness so
// the model can weigh them. Scope is only printed when non-empty; the claim
// usually already names the property/trade.
export function formatBeliefsBlock(beliefs: BeliefRow[]): string {
	if (!beliefs.length) return '';
	const lines = beliefs.map((b) => {
		const scopeKeys = Object.keys(b.scope ?? {});
		const scopeStr = scopeKeys.length
			? ` [scope: ${scopeKeys
					.map((k) => `${k}=${typeof b.scope[k] === 'object' ? JSON.stringify(b.scope[k]) : b.scope[k]}`)
					.join(', ')}]`
			: '';
		return `- (conf ${b.confidence.toFixed(2)}, ${b.explicitness}, by=${b.created_by}) ${b.claim}${scopeStr}`;
	});
	return lines.join('\n');
}
