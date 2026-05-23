// Memory graph — Supabase-backed episodic (observations) + semantic (beliefs)
// store. Workspace-scoped, owns the post-onboarding lifecycle stage (the demo
// flow uses agent/memory.mjs for handle-scoped pre-workspace state). All
// access goes through the REST API with the service-role key, so RLS is
// bypassed and workspace scoping is the caller's responsibility — every
// read/write must pass workspace_id.

import { supabaseEnv } from '../supabase.mjs';
import { resolveEntity, cascadeOwners } from './entities.mjs';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 1536;

function headers(key, extra = {}) {
	return {
		apikey: key,
		Authorization: `Bearer ${key}`,
		'Content-Type': 'application/json',
		Accept: 'application/json',
		...extra
	};
}

// ── embeddings ───────────────────────────────────────────────────────────────

export async function embed(text) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('embed: OPENAI_API_KEY not set');
	const input = String(text ?? '').trim();
	if (!input) return null;
	const res = await fetch('https://api.openai.com/v1/embeddings', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model: EMBEDDING_MODEL, input })
	});
	if (!res.ok) throw new Error(`embed: ${res.status} ${await res.text()}`);
	const body = await res.json();
	const vec = body?.data?.[0]?.embedding;
	if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) {
		throw new Error(`embed: unexpected vector shape (${vec?.length})`);
	}
	return vec;
}

// ── observations ─────────────────────────────────────────────────────────────

export async function addObservation(
	workspace_id,
	{
		title = null,
		summary,
		raw_text = null,
		entities = {},
		salience = 0.5,
		tags = [],
		source_message_id = null,
		session_id = null
	}
) {
	if (!workspace_id) throw new Error('addObservation: workspace_id required');
	if (!summary) throw new Error('addObservation: summary required');

	const { url, key } = supabaseEnv();
	const embedding = await embed(summary);
	const row = {
		workspace_id,
		title,
		summary,
		raw_text,
		entities,
		salience,
		tags,
		source_message_id,
		session_id,
		embedding
	};
	const res = await fetch(`${url}/rest/v1/observations`, {
		method: 'POST',
		headers: headers(key, { Prefer: 'return=representation' }),
		body: JSON.stringify(row)
	});
	if (!res.ok) throw new Error(`addObservation: ${res.status} ${await res.text()}`);
	const [inserted] = await res.json();

	// Resolve entity references and write observation_entities join rows.
	// Each ref may carry a signed weight in [-1, 1] indicating chosen/rejected
	// role in this observation. Default 1.0 for refs without explicit weight.
	if (Array.isArray(entities) && entities.length > 0) {
		const byEntityId = new Map();
		for (const ref of entities) {
			if (!ref || typeof ref !== 'object') continue;
			if (!ref.kind || !ref.name) continue;
			try {
				const ent = await resolveEntity({ workspace_id, kind: ref.kind, name: ref.name });
				if (!ent?.id) continue;
				const w = typeof ref.weight === 'number' ? Math.max(-1, Math.min(1, ref.weight)) : 1.0;
				// Keep the strongest |weight| if the same entity appears twice.
				const prev = byEntityId.get(ent.id);
				if (prev === undefined || Math.abs(w) > Math.abs(prev)) byEntityId.set(ent.id, w);
			} catch (err) {
				console.error(
					`addObservation: resolveEntity failed for ${ref.kind}:${ref.name}: ${err.message}`
				);
			}
		}
		if (byEntityId.size > 0) {
			const joinRows = Array.from(byEntityId.entries()).map(([entity_id, weight]) => ({
				observation_id: inserted.id,
				entity_id,
				weight
			}));
			const jRes = await fetch(`${url}/rest/v1/observation_entities`, {
				method: 'POST',
				headers: headers(key, { Prefer: 'return=minimal' }),
				body: JSON.stringify(joinRows)
			});
			if (!jRes.ok) {
				console.error(
					`addObservation: observation_entities insert failed: ${jRes.status} ${await jRes.text()}`
				);
			}
		}
	}
	return inserted;
}

export async function listObservations(workspace_id, { limit = 100 } = {}) {
	if (!workspace_id) throw new Error('listObservations: workspace_id required');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,ts,summary,raw_text,entities,salience,tags,source_message_id',
		workspace_id: `eq.${workspace_id}`,
		order: 'ts.desc',
		limit: String(limit)
	});
	const res = await fetch(`${url}/rest/v1/observations?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`listObservations: ${res.status} ${await res.text()}`);
	return res.json();
}

export async function recallObservations(
	workspace_id,
	{ query = null, top_k = 5, similarity_floor = 0.0 } = {}
) {
	if (!workspace_id) throw new Error('recallObservations: workspace_id required');
	if (!query) return listObservations(workspace_id, { limit: top_k });
	const { url, key } = supabaseEnv();
	const embedding = await embed(query);
	const res = await fetch(`${url}/rest/v1/rpc/match_observations`, {
		method: 'POST',
		headers: headers(key),
		body: JSON.stringify({
			query_embedding: embedding,
			workspace_id_in: workspace_id,
			match_count: top_k,
			similarity_floor
		})
	});
	if (!res.ok) throw new Error(`recallObservations: ${res.status} ${await res.text()}`);
	return res.json();
}

// ── beliefs ──────────────────────────────────────────────────────────────────

export async function createBelief(
	workspace_id,
	{ claim, scope = {}, confidence, explicitness, created_by, tags = [] }
) {
	if (!workspace_id) throw new Error('createBelief: workspace_id required');
	if (!claim) throw new Error('createBelief: claim required');
	if (typeof confidence !== 'number') throw new Error('createBelief: confidence required');
	if (!explicitness) throw new Error('createBelief: explicitness required');
	if (!created_by) throw new Error('createBelief: created_by required');

	const { url, key } = supabaseEnv();
	const embedding = await embed(embeddingTextForBelief(claim, scope));
	const row = {
		workspace_id,
		claim,
		scope,
		confidence,
		explicitness,
		created_by,
		tags,
		embedding
	};
	const res = await fetch(`${url}/rest/v1/beliefs`, {
		method: 'POST',
		headers: headers(key, { Prefer: 'return=representation' }),
		body: JSON.stringify(row)
	});
	if (!res.ok) throw new Error(`createBelief: ${res.status} ${await res.text()}`);
	const [inserted] = await res.json();
	return inserted;
}

export async function updateBelief(id, patch) {
	if (!id) throw new Error('updateBelief: id required');
	const { url, key } = supabaseEnv();
	const body = { ...patch };
	if (body.claim !== undefined || body.scope !== undefined) {
		body.embedding = await embed(embeddingTextForBelief(body.claim ?? '', body.scope ?? {}));
	}
	const res = await fetch(`${url}/rest/v1/beliefs?id=eq.${id}`, {
		method: 'PATCH',
		headers: headers(key, { Prefer: 'return=representation' }),
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`updateBelief: ${res.status} ${await res.text()}`);
	const [updated] = await res.json();
	return updated;
}

export async function deleteBelief(id) {
	if (!id) throw new Error('deleteBelief: id required');
	const { url, key } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/beliefs?id=eq.${id}`, {
		method: 'DELETE',
		headers: headers(key)
	});
	if (!res.ok) throw new Error(`deleteBelief: ${res.status} ${await res.text()}`);
}

export async function listBeliefs(workspace_id, { limit = 500 } = {}) {
	if (!workspace_id) throw new Error('listBeliefs: workspace_id required');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select:
			'id,claim,scope,confidence,explicitness,created_by,created_at,updated_at,tags,status,evidence_count:belief_evidence(count)',
		workspace_id: `eq.${workspace_id}`,
		order: 'updated_at.desc',
		limit: String(limit)
	});
	const res = await fetch(`${url}/rest/v1/beliefs?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`listBeliefs: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	// PostgREST returns evidence_count as [{ count: N }] — flatten.
	return rows.map((b) => ({
		...b,
		evidence_count: Array.isArray(b.evidence_count) ? (b.evidence_count[0]?.count ?? 0) : 0
	}));
}

export async function recallBeliefs(
	workspace_id,
	{ query = null, top_k = 5, similarity_floor = 0.0 } = {}
) {
	if (!workspace_id) throw new Error('recallBeliefs: workspace_id required');
	if (!query) return listBeliefs(workspace_id, { limit: top_k });
	const { url, key } = supabaseEnv();
	const embedding = await embed(query);
	const res = await fetch(`${url}/rest/v1/rpc/match_beliefs`, {
		method: 'POST',
		headers: headers(key),
		body: JSON.stringify({
			query_embedding: embedding,
			workspace_id_in: workspace_id,
			match_count: top_k,
			similarity_floor
		})
	});
	if (!res.ok) throw new Error(`recallBeliefs: ${res.status} ${await res.text()}`);
	return res.json();
}

// ── belief_evidence ──────────────────────────────────────────────────────────

export async function attachEvidence(belief_id, observation_id, weight = 1.0) {
	if (!belief_id || !observation_id) {
		throw new Error('attachEvidence: belief_id and observation_id required');
	}
	const { url, key } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/belief_evidence`, {
		method: 'POST',
		headers: headers(key, { Prefer: 'resolution=merge-duplicates,return=representation' }),
		body: JSON.stringify({ belief_id, observation_id, weight })
	});
	if (!res.ok) throw new Error(`attachEvidence: ${res.status} ${await res.text()}`);
	const [row] = await res.json();
	return row;
}

export async function evidenceFor(belief_id) {
	if (!belief_id) throw new Error('evidenceFor: belief_id required');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'belief_id,observation_id,weight,created_at,observation:observations(*)',
		belief_id: `eq.${belief_id}`
	});
	const res = await fetch(`${url}/rest/v1/belief_evidence?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`evidenceFor: ${res.status} ${await res.text()}`);
	return res.json();
}

export async function listEdges(workspace_id) {
	// Edges scoped to a workspace via the belief side.
	if (!workspace_id) throw new Error('listEdges: workspace_id required');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'belief_id,observation_id,weight,belief:beliefs!inner(workspace_id)',
		'belief.workspace_id': `eq.${workspace_id}`
	});
	const res = await fetch(`${url}/rest/v1/belief_evidence?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`listEdges: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows.map((r) => ({
		belief_id: r.belief_id,
		observation_id: r.observation_id,
		weight: r.weight
	}));
}

// ── entity-anchored recall (structural tier of hybrid retrieval) ────────────

/**
 * Walk belief_entities for every belief tagged to any of the given entity ids.
 * Higher-precision than vector recall — used as the primary signal when the
 * caller already knows which entities the query is about (e.g. a resolved
 * property + cascaded owners). Returns full belief rows with evidence_count
 * and a matched_entity_ids array showing which of the input entities matched.
 */
export async function beliefsForEntities(workspace_id, entity_ids, { limit = 50 } = {}) {
	if (!workspace_id) throw new Error('beliefsForEntities: workspace_id required');
	if (!Array.isArray(entity_ids) || entity_ids.length === 0) return [];
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select:
			'entity_id,belief:beliefs!inner(id,claim,scope,confidence,explicitness,created_by,created_at,updated_at,tags,status,evidence_count:belief_evidence(count))',
		'belief.workspace_id': `eq.${workspace_id}`,
		entity_id: `in.(${entity_ids.join(',')})`,
		limit: String(limit)
	});
	const res = await fetch(`${url}/rest/v1/belief_entities?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`beliefsForEntities: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	const seen = new Map();
	for (const row of rows) {
		const b = row.belief;
		if (!b) continue;
		const evCount = Array.isArray(b.evidence_count) ? (b.evidence_count[0]?.count ?? 0) : 0;
		if (!seen.has(b.id)) {
			seen.set(b.id, { ...b, evidence_count: evCount, matched_entity_ids: [row.entity_id] });
		} else {
			seen.get(b.id).matched_entity_ids.push(row.entity_id);
		}
	}
	return Array.from(seen.values());
}

/**
 * Walk observation_entities for every obs tagged to any of the given entity
 * ids. The join carries a signed weight ∈ [-1, 1]; we keep the strongest
 * |weight| if an obs matches via multiple entities. Sorted recent-first.
 */
export async function observationsForEntities(workspace_id, entity_ids, { limit = 50 } = {}) {
	if (!workspace_id) throw new Error('observationsForEntities: workspace_id required');
	if (!Array.isArray(entity_ids) || entity_ids.length === 0) return [];
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select:
			'entity_id,weight,observation:observations!inner(id,ts,summary,raw_text,entities,salience,tags,source_message_id,session_id)',
		'observation.workspace_id': `eq.${workspace_id}`,
		entity_id: `in.(${entity_ids.join(',')})`,
		limit: String(limit)
	});
	const res = await fetch(`${url}/rest/v1/observation_entities?${params}`, {
		headers: headers(key)
	});
	if (!res.ok) throw new Error(`observationsForEntities: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	const seen = new Map();
	for (const row of rows) {
		const o = row.observation;
		if (!o) continue;
		const w = typeof row.weight === 'number' ? row.weight : 1;
		if (!seen.has(o.id)) {
			seen.set(o.id, { ...o, matched_entity_ids: [row.entity_id], weight: w });
		} else {
			const ex = seen.get(o.id);
			ex.matched_entity_ids.push(row.entity_id);
			if (Math.abs(w) > Math.abs(ex.weight)) ex.weight = w;
		}
	}
	return Array.from(seen.values()).sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
}

// ── legacy PMS fallbacks (third tier of hybrid retrieval) ───────────────────

/**
 * Legacy `vendors` table lookup by trade keyword. Used as the escape hatch
 * when the memory graph has no relevant beliefs/obs for a vendor query.
 * Trade column is free-text; matches substring case-insensitively.
 */
export async function legacyVendorsForTrade(workspace_id, trade, { limit = 10 } = {}) {
	if (!workspace_id) throw new Error('legacyVendorsForTrade: workspace_id required');
	if (!trade) return [];
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,name,trade,phone,email',
		workspace_id: `eq.${workspace_id}`,
		trade: `ilike.*${trade}*`,
		limit: String(limit)
	});
	const res = await fetch(`${url}/rest/v1/vendors?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`legacyVendorsForTrade: ${res.status} ${await res.text()}`);
	return res.json();
}

/**
 * Legacy `owner_properties` lookup. Given a property's legacy ref_id, returns
 * raw owner rows (no entity promotion). Used by the recall tool's legacy
 * fallback when the property entity hasn't been promoted yet — cascadeOwners
 * is the entity-creating counterpart used during ingest.
 */
export async function legacyOwnerForProperty(workspace_id, property_ref_id) {
	if (!workspace_id) throw new Error('legacyOwnerForProperty: workspace_id required');
	if (!property_ref_id) return [];
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'owner:owners(id,name)',
		property_id: `eq.${property_ref_id}`,
		workspace_id: `eq.${workspace_id}`
	});
	const res = await fetch(`${url}/rest/v1/owner_properties?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`legacyOwnerForProperty: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows.map((r) => r.owner).filter(Boolean);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function embeddingTextForBelief(claim, scope) {
	const scopeStr = Object.entries(scope || {})
		.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
		.join(' ');
	return scopeStr ? `${claim}  [scope: ${scopeStr}]` : claim;
}
