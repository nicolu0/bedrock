// Entity nodes — promote vendors, properties, and owners that get mentioned
// in observations or beliefs to first-class nodes in the memory graph. An
// entity row exists if-and-only-if something named it; we don't pre-populate
// from the legacy tables.
//
// resolveEntity is the only write surface — it does find-or-create with a
// 3-step lookup:
//   1. Match the legacy business table by name (vendors / properties / owners).
//      If found, ensure an entity row exists with ref_table/ref_id pointing
//      there. Promotion is idempotent: subsequent calls return the same row.
//   2. Otherwise vector-search entities by (kind, name_embedding) at ≥0.85
//      similarity. Handles "Mario" / "Mario " / "Mario  " variants.
//   3. Otherwise INSERT a new entity row with ref_table=null. Informal
//      entities (portfolios like "Harrison Properties") live here.
//
// Belief consolidation uses recallEntityBeliefs(entity_id) for high-precision
// candidate retrieval — a new observation about Kori finds the existing
// "Kori is handyman for Harrison Properties" belief via FK, not vector.

import { embed } from './memory.mjs';
import { supabaseEnv } from './supabase.mjs';

// Per-kind vector-match thresholds. Properties need a higher floor because
// short numbered street names ("15th street", "17th street", "828 11th",
// "918 12th") produce near-identical embeddings — at 0.72 the matcher merges
// genuinely distinct properties. Vendors stay at 0.72 because vendor-name
// dedup (Waad/Waadt) leans on the Levenshtein fallback in findLegacyRow.
const SIMILARITY_FLOORS = {
	vendor: 0.72,
	property: 0.88,
	owner: 0.82
};
function similarityFloor(kind) {
	return SIMILARITY_FLOORS[kind] ?? 0.72;
}

const REF_TABLES = {
	vendor: 'vendors',
	property: 'properties',
	owner: 'owners'
};

// ── normalization helpers (PR1.5) ────────────────────────────────────────────

// Canonical street-type abbreviations. Used so chat's "908 15th street" and
// legacy's "908 15th St" compare equal.
const STREET_TYPE_CANONICAL = {
	street: 'st',
	st: 'st',
	drive: 'dr',
	dr: 'dr',
	place: 'pl',
	pl: 'pl',
	lane: 'ln',
	ln: 'ln',
	avenue: 'ave',
	ave: 'ave',
	boulevard: 'blvd',
	blvd: 'blvd',
	court: 'ct',
	ct: 'ct',
	road: 'rd',
	rd: 'rd'
};

function normalizePropertyName(name) {
	if (!name) return '';
	let s = String(name).toLowerCase();
	s = s.replace(/[.,]/g, ''); // strip periods, commas
	s = s.replace(/\s+/g, ' ').trim();
	const tokens = s.split(' ');
	const out = tokens.map((t) => STREET_TYPE_CANONICAL[t] ?? t);
	return out.join(' ');
}

// Vendor names sometimes have wild punctuation in legacy ("L.A.HYDRO-JET &
// ROOTER SERVICE, INC.") vs chat shorthand ("LA HydroJet"). Strip ALL non-
// alphanumerics (including spaces) so the two collapse to "lahydrojet" and
// "lahydrojetrooterserviceinc" — substring match works regardless of how the
// chat tokenized things.
function normalizeVendorName(name) {
	if (!name) return '';
	return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Owner names are usually long enough that simple lowercase comparison works.
function normalizeOwnerName(name) {
	if (!name) return '';
	return String(name).toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeByKind(kind, name) {
	if (kind === 'vendor') return normalizeVendorName(name);
	if (kind === 'property') return normalizePropertyName(name);
	if (kind === 'owner') return normalizeOwnerName(name);
	return String(name ?? '').toLowerCase().trim();
}

// Standard Levenshtein distance. Used to merge vendor typos like
// "Waad appliance" / "Waadt Appliance" (distance = 1) at the legacy-lookup
// step before they get vector-merged into separate informal entities.
function levenshtein(a, b) {
	if (a === b) return 0;
	if (!a) return b.length;
	if (!b) return a.length;
	let prev = new Array(b.length + 1);
	let curr = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}
	return prev[b.length];
}

function headers(key, extra = {}) {
	return {
		apikey: key,
		Authorization: `Bearer ${key}`,
		'Content-Type': 'application/json',
		Accept: 'application/json',
		...extra
	};
}

// ── core helpers ─────────────────────────────────────────────────────────────

function normalizeName(name) {
	return String(name ?? '').trim();
}

async function findLegacyRow(workspace_id, kind, name) {
	const refTable = REF_TABLES[kind];
	if (!refTable) return null;
	const nm = String(name ?? '').trim();
	if (!nm) return null;
	const { url, key } = supabaseEnv();

	// Pull all rows of this workspace+kind once. Property/owner counts are
	// usually <100 per workspace; vendor counts are a few hundred. Fetching
	// the set is cheaper than two ILIKE round-trips and lets us do
	// normalized comparison + Levenshtein in JS, both impossible with raw
	// PostgREST.
	const cols =
		kind === 'property' ? 'id,name,appfolio_property_id,appfolio_property_number' : 'id,name';
	const res = await fetch(
		`${url}/rest/v1/${refTable}?select=${cols}&workspace_id=eq.${workspace_id}&limit=500`,
		{ headers: headers(key) }
	);
	if (!res.ok) return null;
	const rows = await res.json();
	if (!rows.length) return null;

	// PASS 1 (property only): Resolve numeric-prefixed property references.
	// Chat uses two patterns we need to handle:
	//
	//   (a) "294 Ozone" — AppFolio property NUMBER shorthand. The "294" is
	//       not part of any address; it's the AppFolio internal property
	//       number for 15 Ozone Ave. Resolved via appfolio_property_number.
	//   (b) "221-229 Union Pl" or "4641 1/2 Pickford" — real address
	//       (possibly with a sub-unit). The leading number IS part of the
	//       legacy property name itself.
	//
	// Distinguishing: if any legacy property NAME starts with the chat's
	// leading number followed by space or hyphen, that's case (b) and we
	// use leading-number address match. Otherwise we treat the first token
	// as an AppFolio number (case a).
	//
	// Without this split, "221-229 Union Pl" would falsely match the property
	// whose appfolio_property_number happens to be "221" (= 1234 11th St).
	if (kind === 'property') {
		const firstToken = nm.split(/\s+/)[0];
		if (firstToken) {
			// Only treat as a numeric prefix if firstToken is PURE digits or a
			// digit range like "180-10" / "4641-4643". Ordinal-style tokens like
			// "15th" or "11th" must NOT match — those are part of a street name
			// (15th Street, 11th St) and should fall through to normalized match.
			const isNumericToken = /^\d+(-\d+)?$/.test(firstToken);
			const leadingNumMatch = isNumericToken ? firstToken.match(/^\d+/) : null;
			const leadingNum = leadingNumMatch ? leadingNumMatch[0] : null;
			const looksLikeAddress =
				leadingNum &&
				rows.some((r) => {
					const rn = String(r.name);
					return rn.startsWith(leadingNum + ' ') || rn.startsWith(leadingNum + '-');
				});

			if (looksLikeAddress) {
				// (b) Leading-number address match — chat "4641 1/2 Pickford"
				// → legacy "4641-4643 Pickford St".
				const rangeMatch = rows.find((r) => {
					const rn = String(r.name);
					return (
						rn.startsWith(leadingNum + ' ') || rn.startsWith(leadingNum + '-')
					);
				});
				if (rangeMatch) return rangeMatch;
			} else {
				// (a) AppFolio property number/id — chat "294 Ozone" or
				// "180-10 11th St".
				const propNum = firstToken.split('-')[0];
				const appfMatch = rows.find(
					(r) =>
						r.appfolio_property_number === propNum ||
						r.appfolio_property_id === propNum
				);
				if (appfMatch) return appfMatch;
			}
		}
	}

	// PASS 2: normalized exact + substring match.
	const target = normalizeByKind(kind, nm);
	if (!target) return null;

	// 2a. Exact normalized match.
	let best = rows.find((r) => normalizeByKind(kind, r.name) === target);
	if (best) return best;

	// 2b. Substring containment in either direction (handles "Yonic" matching
	// legacy "Yonic Herrera"; also "908 15th street" matching "908 15th St"
	// after street-type canonicalization).
	best = rows.find((r) => {
		const rn = normalizeByKind(kind, r.name);
		return rn && (rn.includes(target) || target.includes(rn));
	});
	if (best) return best;

	// PASS 3 (vendor only): Levenshtein fallback for typos like Waad/Waadt
	// (distance = 1). Threshold scales with the shorter name length so short
	// names don't get over-merged.
	if (kind === 'vendor') {
		let bestLev = null;
		let bestDist = Infinity;
		for (const r of rows) {
			const rn = normalizeByKind(kind, r.name);
			if (!rn) continue;
			const dist = levenshtein(rn, target);
			const len = Math.min(rn.length, target.length);
			const threshold = Math.max(2, Math.floor(len * 0.25));
			if (dist <= threshold && dist < bestDist) {
				bestLev = r;
				bestDist = dist;
			}
		}
		if (bestLev) return bestLev;
	}

	return null;
}

async function fetchEntityByRef(workspace_id, ref_table, ref_id) {
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: '*',
		workspace_id: `eq.${workspace_id}`,
		ref_table: `eq.${ref_table}`,
		ref_id: `eq.${ref_id}`,
		limit: '1'
	});
	const res = await fetch(`${url}/rest/v1/entities?${params}`, { headers: headers(key) });
	if (!res.ok) return null;
	const rows = await res.json();
	return rows[0] ?? null;
}

async function vectorMatchEntity(workspace_id, kind, name) {
	const e = await embed(name);
	if (!e) return null;
	const { url, key } = supabaseEnv();
	// Inline cosine search via PostgREST raw filter is awkward; use a simple
	// RPC-free path: pull top-3 by vector then filter in Node. The HNSW index
	// keeps this fast enough for any reasonable entity count.
	const floor = similarityFloor(kind);
	const res = await fetch(`${url}/rest/v1/rpc/match_entities`, {
		method: 'POST',
		headers: headers(key),
		body: JSON.stringify({
			query_embedding: e,
			workspace_id_in: workspace_id,
			kind_in: kind,
			match_count: 3,
			similarity_floor: floor
		})
	}).catch(() => null);
	if (res && res.ok) {
		const rows = await res.json();
		return rows[0] ?? null;
	}
	// Fallback: pull entities of this kind, embed name, compare in Node. Used
	// when the match_entities RPC isn't deployed yet.
	const params = new URLSearchParams({
		select: 'id,name,name_embedding,ref_table,ref_id',
		workspace_id: `eq.${workspace_id}`,
		kind: `eq.${kind}`,
		limit: '500'
	});
	const fbRes = await fetch(`${url}/rest/v1/entities?${params}`, { headers: headers(key) });
	if (!fbRes.ok) return null;
	const rows = await fbRes.json();
	let best = null;
	let bestSim = floor;
	for (const row of rows) {
		if (!row.name_embedding) continue;
		// name_embedding from PostgREST is "[0.1,0.2,...]" string
		const emb =
			typeof row.name_embedding === 'string'
				? JSON.parse(row.name_embedding)
				: row.name_embedding;
		const sim = cosineSimilarity(e, emb);
		if (sim > bestSim) {
			best = row;
			bestSim = sim;
		}
	}
	return best;
}

function cosineSimilarity(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (!na || !nb) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function insertEntity({ workspace_id, kind, name, ref_table, ref_id }) {
	const { url, key } = supabaseEnv();
	const embedding = await embed(name);
	const row = {
		workspace_id,
		kind,
		name,
		name_embedding: embedding,
		ref_table: ref_table ?? null,
		ref_id: ref_id ?? null
	};
	const res = await fetch(`${url}/rest/v1/entities`, {
		method: 'POST',
		headers: headers(key, { Prefer: 'return=representation' }),
		body: JSON.stringify(row)
	});
	if (!res.ok) throw new Error(`insertEntity: ${res.status} ${await res.text()}`);
	const [inserted] = await res.json();
	return inserted;
}

// ── public api ───────────────────────────────────────────────────────────────

/**
 * Resolve an LLM-mentioned (kind, name) to an entity row. Find-or-create.
 * Three-step: legacy table → vector-match in entities → create new.
 * Returns { id, name, kind, ref_table, ref_id, created: bool }.
 */
export async function resolveEntity({ workspace_id, kind, name }) {
	if (!workspace_id) throw new Error('resolveEntity: workspace_id required');
	if (!kind) throw new Error('resolveEntity: kind required');
	const nm = normalizeName(name);
	if (!nm) throw new Error('resolveEntity: name required');

	// Step 1: legacy table lookup.
	const refTable = REF_TABLES[kind];
	if (refTable) {
		const legacy = await findLegacyRow(workspace_id, kind, nm);
		if (legacy) {
			const existing = await fetchEntityByRef(workspace_id, refTable, legacy.id);
			if (existing) return { ...existing, created: false };
			const created = await insertEntity({
				workspace_id,
				kind,
				name: legacy.name ?? nm,
				ref_table: refTable,
				ref_id: legacy.id
			});
			return { ...created, created: true };
		}
	}

	// Step 2: vector match against existing informal entities of this kind.
	const match = await vectorMatchEntity(workspace_id, kind, nm);
	if (match) return { ...match, created: false };

	// Step 3: create new informal entity.
	const created = await insertEntity({ workspace_id, kind, name: nm });
	return { ...created, created: true };
}

/**
 * Idempotent edge insert. Pass a belief_id and a flat list of entity_ids.
 * Returns the count of edges newly created.
 */
export async function attachEntityEdges(belief_id, entity_ids = []) {
	if (!belief_id) throw new Error('attachEntityEdges: belief_id required');
	const ids = [...new Set((entity_ids ?? []).filter(Boolean))];
	if (!ids.length) return 0;
	const { url, key } = supabaseEnv();
	const rows = ids.map((entity_id) => ({ belief_id, entity_id }));
	const res = await fetch(`${url}/rest/v1/belief_entities`, {
		method: 'POST',
		headers: headers(key, {
			Prefer: 'resolution=ignore-duplicates,return=representation'
		}),
		body: JSON.stringify(rows)
	});
	if (!res.ok) throw new Error(`attachEntityEdges: ${res.status} ${await res.text()}`);
	const inserted = await res.json();
	return Array.isArray(inserted) ? inserted.length : 0;
}

/**
 * Beliefs that share an entity with the given entity_id. FK join, no vector
 * search — high-precision candidate retrieval for the belief-former.
 */
export async function recallEntityBeliefs(entity_id, { limit = 25 } = {}) {
	if (!entity_id) throw new Error('recallEntityBeliefs: entity_id required');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select:
			'belief_id,belief:beliefs(id,claim,scope,confidence,explicitness,created_by,created_at,updated_at,tags)',
		entity_id: `eq.${entity_id}`,
		limit: String(limit)
	});
	const res = await fetch(`${url}/rest/v1/belief_entities?${params}`, {
		headers: headers(key)
	});
	if (!res.ok) throw new Error(`recallEntityBeliefs: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows.map((r) => r.belief).filter(Boolean);
}

/**
 * List all entities of a given kind in a workspace. For the UI Entities tab.
 */
export async function recallEntitiesByKind(workspace_id, kind, { limit = 500 } = {}) {
	if (!workspace_id) throw new Error('recallEntitiesByKind: workspace_id required');
	if (!kind) throw new Error('recallEntitiesByKind: kind required');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,kind,name,ref_table,ref_id,metadata,created_at,updated_at',
		workspace_id: `eq.${workspace_id}`,
		kind: `eq.${kind}`,
		order: 'name.asc',
		limit: String(limit)
	});
	const res = await fetch(`${url}/rest/v1/entities?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`recallEntitiesByKind: ${res.status} ${await res.text()}`);
	return res.json();
}

/**
 * List every entity in a workspace. For the UI Entities tab.
 */
export async function listEntities(workspace_id, { limit = 1000 } = {}) {
	if (!workspace_id) throw new Error('listEntities: workspace_id required');
	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'id,kind,name,ref_table,ref_id,metadata,created_at,updated_at',
		workspace_id: `eq.${workspace_id}`,
		order: 'kind.asc,name.asc',
		limit: String(limit)
	});
	const res = await fetch(`${url}/rest/v1/entities?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`listEntities: ${res.status} ${await res.text()}`);
	return res.json();
}

/**
 * Property → owner cascade. Given a resolved property entity, look up the
 * owners that legacy `owner_properties` says co-own that property and resolve
 * each to an owner entity. Returns the owner entities (possibly empty).
 *
 * Asymmetric on purpose: properties cascade UP to owners; owners do NOT
 * cascade down to all their properties (would be too noisy when the PM names
 * a portfolio in passing).
 *
 * Must be called by the entity-emit path (not from inside resolveEntity),
 * otherwise belief-former re-resolves would double-cascade.
 */
export async function cascadeOwners(property_entity, workspace_id) {
	if (!property_entity || property_entity.kind !== 'property') return [];
	if (!property_entity.ref_id) return []; // informal property, no legacy backing
	if (!workspace_id) throw new Error('cascadeOwners: workspace_id required');

	const { url, key } = supabaseEnv();
	const params = new URLSearchParams({
		select: 'owner:owners(id,name)',
		property_id: `eq.${property_entity.ref_id}`,
		workspace_id: `eq.${workspace_id}`
	});
	const res = await fetch(`${url}/rest/v1/owner_properties?${params}`, { headers: headers(key) });
	if (!res.ok) throw new Error(`cascadeOwners: ${res.status} ${await res.text()}`);
	const rows = await res.json();

	const resolved = [];
	for (const row of rows) {
		const owner = row.owner;
		if (!owner?.name) continue;
		try {
			const ent = await resolveEntity({ workspace_id, kind: 'owner', name: owner.name });
			resolved.push(ent);
		} catch (err) {
			console.error(`cascadeOwners: resolveEntity(owner, ${owner.name}) failed:`, err.message);
		}
	}
	return resolved;
}
