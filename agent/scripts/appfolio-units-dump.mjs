// Dump all AppFolio units for a workspace's properties + cross-reference with
// the current Bedrock units table. Produces a JSON payload for the HTML
// reviewer at .claude/artifacts/2026-05-23-units-review.html.
//
// Usage:
//   node agent/scripts/appfolio-units-dump.mjs              # prod workspace
//   node agent/scripts/appfolio-units-dump.mjs --workspace=test
//   node agent/scripts/appfolio-units-dump.mjs --out=path.json
//
// Probes a wide column set against AppFolio's unit_directory report — including
// speculative columns (unit_number, apt_number, unit_label, room_number, etc.)
// — so we can see whether AppFolio exposes any cleaner identifier than the
// prefixed unit_name we've been storing.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { supabaseEnv } from '../core/supabase.mjs';
import { WORKSPACES } from '../core/workspaces.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(__dirname, '..', 'data', 'appfolio-units-dump.json');

const ARGV = Object.fromEntries(
	process.argv.slice(2).map((arg) => {
		const m = arg.match(/^--([^=]+)=(.*)$/);
		return m ? [m[1], m[2]] : [arg.replace(/^--/, ''), true];
	})
);

const WORKSPACE_LABEL = ARGV.workspace ?? 'prod';
const OUT = ARGV.out ?? DEFAULT_OUT;

// AppFolio rejects the whole request with "Columns are invalid" when any
// unknown column is in the list — no silent drop. So we use only the
// columns the existing sync uses; this confirms no separate unit_number
// field is hiding in this report.
const UNIT_COLUMNS = [
	'unit_id', 'property_id', 'unit_name', 'unit_address',
	'unit_street', 'unit_city', 'unit_state', 'unit_zip',
	'sqft', 'bedrooms', 'bathrooms'
];

function findWorkspaceIdByLabel(label) {
	for (const [id, w] of Object.entries(WORKSPACES)) {
		if (w.label === label) return id;
	}
	throw new Error(`unknown workspace label "${label}" — known: ${Object.values(WORKSPACES).map((w) => w.label).join(', ')}`);
}

function appfolioCreds() {
	const id = process.env.APPFOLIO_CLIENT_ID;
	const secret = process.env.APPFOLIO_CLIENT_SECRET;
	const vhost = process.env.APPFOLIO_VHOST;
	if (!id || !secret || !vhost) throw new Error('APPFOLIO_CLIENT_ID/SECRET/VHOST not set');
	return { id, secret, vhost };
}

async function appfolioFetch(reportName, body) {
	const { id, secret, vhost } = appfolioCreds();
	const auth = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
	const rows = [];
	let url = `https://${vhost}/api/v2/reports/${reportName}.json`;
	let isFirst = true;
	while (url) {
		const u = new URL(url);
		u.username = u.password = '';
		const res = await fetch(u, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: auth },
			body: isFirst ? JSON.stringify(body) : JSON.stringify({})
		});
		if (!res.ok) throw new Error(`AppFolio ${reportName} ${res.status}: ${await res.text()}`);
		const json = await res.json();
		if (Array.isArray(json)) {
			rows.push(...json);
			break;
		}
		rows.push(...(json.results ?? []));
		url = json.next_page_url ?? null;
		isFirst = false;
	}
	return rows;
}

async function loadEnvFile() {
	// Lightweight .env loader — only handles KEY=VALUE lines, no fancy quoting.
	for (const candidate of [
		path.join(__dirname, '..', '..', '.env'),
		path.join(__dirname, '..', '.env')
	]) {
		try {
			const text = await fs.readFile(candidate, 'utf8');
			for (const line of text.split('\n')) {
				const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
				if (!m) continue;
				const k = m[1];
				let v = m[2].trim();
				if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
					v = v.slice(1, -1);
				}
				if (process.env[k] == null) process.env[k] = v;
			}
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
	}
}

async function supabaseGet(rel) {
	const { url, key } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/${rel}`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`Supabase ${rel}: ${res.status} ${await res.text()}`);
	return res.json();
}

// Option B: derive the unit's canonical short address from AppFolio's
// unit_address field. AppFolio has already done the work of identifying the
// unit (Unit A, #3D, etc.) — we just strip city/state/zip and abbreviate
// the street type. Falls back to the legacy normalizeUnitName for the rare
// row with no address.

const KNOWN_CITIES = [
	'Santa Monica', 'Los Angeles', 'Venice', 'Marina Del Rey',
	'Beverly Hills', 'Brentwood', 'Culver City',
	'Rancho Palos Verdes', 'Tarzana', 'West Hollywood',
	'Mar Vista', 'Pacific Palisades' // hedge against future additions
];

function abbreviateStreet(s) {
	return s
		.replace(/\bStreet\b\.?/gi, 'St')
		.replace(/\bAvenue\b\.?/gi, 'Ave')
		.replace(/\bBoulevard\b\.?/gi, 'Blvd')
		.replace(/\bPlace\b\.?/gi, 'Pl')
		.replace(/\bDrive\b\.?/gi, 'Dr')
		.replace(/\bCourt\b\.?/gi, 'Ct')
		.replace(/\bLane\b\.?/gi, 'Ln')
		.replace(/\bRoad\b\.?/gi, 'Rd')
		.replace(/\bTerrace\b\.?/gi, 'Ter')
		.replace(/\bCircle\b\.?/gi, 'Cir');
}

function looksLikeAddress(s) {
	if (!s) return false;
	return /^\d/.test(s.trim()) &&
		/\b(Place|Street|Avenue|Boulevard|Lane|Road|Drive|Way|Court|Terrace|Circle|Pl|St|Ave|Blvd|Ln|Rd|Dr|Ct|Ter|Cir)\b/i.test(s);
}

// Parse the AppFolio unit address into either:
//   { street: "1021 17th St", suffix: "Unit A" }
//   { street: "1030 Bay St", suffix: null }  (single-family — just the street)
// or null if unparseable.
function parseUnitAddress(rawAddress) {
	if (!rawAddress) return null;
	let s = String(rawAddress).trim();
	// Strip ", ST ZIP" or " ST ZIP" at end.
	s = s.replace(/[\s,]+[A-Z]{2}\s+\d{5}(?:-\d{4})?\s*$/, '');
	// Strip trailing known city (longest-first to avoid prefix collisions).
	const sorted = [...KNOWN_CITIES].sort((a, b) => b.length - a.length);
	for (const city of sorted) {
		const cityRe = new RegExp(`[\\s,]+${city.replace(/ /g, '\\s+')}\\s*$`, 'i');
		if (cityRe.test(s)) {
			s = s.replace(cityRe, '');
			break;
		}
	}
	s = s.replace(/\s+/g, ' ').trim();

	// Split street ↔ suffix. AppFolio uses several separators:
	//   "1021 17th Street, Unit A"      ← comma + space
	//   "1101 Lincoln Blvd. - Garage"   ← space-dash-space
	//   "1115 23rd Street 1"            ← plain trailing token
	let street = s;
	let suffix = null;
	let m;
	if ((m = s.match(/^(.+?)\s*-\s+(.+)$/))) {
		// " - {suffix}"
		street = m[1];
		suffix = m[2];
	} else if ((m = s.match(/^(.+?),\s*(.+)$/))) {
		// ", {suffix}"
		street = m[1];
		suffix = m[2];
	} else if ((m = s.match(/^(.+?\b(?:St|Ave|Blvd|Pl|Dr|Ct|Ln|Rd|Ter|Cir|Street|Avenue|Boulevard|Place|Drive|Court|Lane|Road|Terrace|Circle|Way))\.?\s+([#\dA-Z][\w\-#&. /]*)$/i))) {
		// "...Street {suffix}" — trailing token after street-type word
		street = m[1];
		suffix = m[2];
	}

	// AppFolio data quirks around the " - " separator:
	//   "{address} - {address}"   → suffix is a more-specific address; use it.
	//   "{address} - {owner_name}" → suffix is junk; drop it.
	//   "{owner_name}, {address}" → street is junk; use suffix as street.
	if (suffix && looksLikeAddress(street) && looksLikeAddress(suffix)) {
		street = suffix;
		suffix = null;
	} else if (suffix && looksLikeAddress(street) && !looksLikeAddress(suffix)) {
		// Heuristic: suffix is a single "real" designator (Unit A, #3D, Garage)?
		// Then keep it. Otherwise drop as junk (owner name, etc.).
		const looksDesig = /^(unit|apt|apartment|#|ste|suite|garage|hoa|storage|pkg|parking|laundry)\b/i.test(suffix) ||
			/^[\dA-Z][\dA-Z]?[A-Z]?$/.test(suffix);
		if (!looksDesig) suffix = null;
	} else if (suffix && !looksLikeAddress(street) && looksLikeAddress(suffix)) {
		street = suffix;
		suffix = null;
	}

	street = abbreviateStreet(street).replace(/\.\s*$/, '').trim();
	if (suffix) suffix = suffix.trim();
	return { street, suffix };
}

// Normalize the suffix into the canonical form: bare designator with no
// leading marker, ready to be slotted into "Unit {X} {Street}".
//   "Unit A"  → "A"
//   "#3D"     → "3D"
//   "Apt 7"   → "7"
//   "294-A"   → "A"            (strip property-number prefix)
//   "1B"      → "1B"
//   "Garage"  → "Garage"       (descriptive — flagged via isDescriptive())
function normalizeSuffix(suffix, propertyNumber) {
	if (!suffix) return null;
	let s = String(suffix).trim();
	if (propertyNumber) {
		const re = new RegExp(`^${propertyNumber}\\s*-\\s*`);
		s = s.replace(re, '');
	}
	const m = s.match(/^\d+\s*-\s*(.+)$/);
	if (m) s = m[1];
	// Strip chained leading markers: "Unit #3" → "#3" → "3".
	let prev;
	do {
		prev = s;
		s = s.replace(/^(unit|apt|apartment|#)\s*/i, '').trim();
	} while (s !== prev);
	return s || null;
}

function isDescriptive(suffix) {
	return /^(garage|pkg|hoa|storage|parking|laundry)/i.test(suffix);
}

// Render the unit's full canonical address as: "Unit {X} {Street}".
// Descriptive suffixes skip the "Unit" prefix: "Garage 1101 Lincoln Blvd".
// No suffix at all → just the street ("1030 Bay St"), but the caller may
// still decide to flag that as NULL/single-family elsewhere.
function formatProposedFromAddress(parsed, propertyNumber) {
	if (!parsed) return null;
	const suffix = normalizeSuffix(parsed.suffix, propertyNumber);
	if (!suffix) return parsed.street;
	if (isDescriptive(suffix)) return `${suffix} ${parsed.street}`;
	return `Unit ${suffix} ${parsed.street}`;
}

function stripUnitNamePrefix(rawName, propertyNumber) {
	if (!rawName) return null;
	const trimmed = String(rawName).trim();
	if (!trimmed) return null;
	if (propertyNumber && trimmed === String(propertyNumber).trim()) return null;
	const m = trimmed.match(/^\d+\s*-\s*(.+)$/);
	return m ? m[1].trim() : trimmed;
}

// Choose the best proposed name for this unit. Address-first; falls back to
// composing "Unit {stripped_unit_name} {property_street}" when the address
// is degenerate (same parsed address for multiple sibling units).
//
// `siblingStreetCounts` is a Map<parsed_street, count> across all units in
// the same property — anything > 1 means the bare street doesn't
// disambiguate, so we must include a suffix.
//
// `totalSiblings` is the total unit count for this property — used to detect
// genuine single-family (count === 1) where the name can be just the street.
function deriveProposedName(unit, prop, siblingStreetCounts, totalSiblings) {
	const parsed = parseUnitAddress(unit.unit_address);
	// Case 1: address parses cleanly and has its own suffix → trust it.
	if (parsed && parsed.suffix) {
		return formatProposedFromAddress(parsed, prop.appfolio_property_number);
	}
	// Case 2: address has no suffix. Either single-family (count == 1) or the
	// property has multiple units that share this street (count > 1) — like
	// 50 Rose Ave where AppFolio omits the unit on some rows.
	if (parsed && !parsed.suffix) {
		const count = siblingStreetCounts.get(parsed.street) ?? 1;
		// If this unit's street uniquely identifies it within the property,
		// just use the street — no need for a "Unit X" wrapper. Handles:
		//   - True single-family (one unit, street == property name)
		//   - Multi-address properties like 2919/2919.5/2921 Van Buren Pl
		//     where each unit IS its own street.
		if (count === 1) {
			return parsed.street;
		}
		// Sibling collision OR street ≠ property name → need a suffix. Synthesize
		// from the stripped unit_name, normalizing the same way address-suffixes
		// get normalized.
		const stripped = stripUnitNamePrefix(unit.unit_name, prop.appfolio_property_number);
		const suffix = normalizeSuffix(stripped, prop.appfolio_property_number);
		if (suffix) {
			if (isDescriptive(suffix)) return `${suffix} ${parsed.street}`;
			return `Unit ${suffix} ${parsed.street}`;
		}
		return parsed.street;
	}
	// Case 3: no address at all. Last-resort fallback to unit_name strip.
	return stripUnitNamePrefix(unit.unit_name, prop.appfolio_property_number);
}

async function main() {
	await loadEnvFile();
	const workspaceId = findWorkspaceIdByLabel(WORKSPACE_LABEL);
	console.error(`workspace: ${WORKSPACE_LABEL} (${workspaceId})`);

	// 1. Properties from Bedrock — appfolio_property_id + appfolio_property_number.
	const propRows = await supabaseGet(
		`properties?select=id,name,appfolio_property_id,appfolio_property_number&workspace_id=eq.${workspaceId}&order=name.asc`
	);
	const propByAppfolioId = new Map();
	for (const p of propRows) {
		if (p.appfolio_property_id) propByAppfolioId.set(String(p.appfolio_property_id), p);
	}
	console.error(`Bedrock properties: ${propRows.length} (${propByAppfolioId.size} with appfolio_property_id)`);

	// 2. Current Bedrock units, keyed by appfolio_unit_id.
	const unitRows = await supabaseGet(
		`units?select=id,property_id,name,appfolio_unit_id&workspace_id=eq.${workspaceId}`
	);
	const bedrockUnitByAppfolioId = new Map();
	for (const u of unitRows) {
		if (u.appfolio_unit_id) bedrockUnitByAppfolioId.set(String(u.appfolio_unit_id), u);
	}
	console.error(`Bedrock units: ${unitRows.length} (${bedrockUnitByAppfolioId.size} with appfolio_unit_id)`);

	// 3. AppFolio unit_directory — one call with all property ids.
	const appfolioIds = [...propByAppfolioId.keys()];
	console.error(`Fetching AppFolio unit_directory for ${appfolioIds.length} properties…`);
	const afRows = await appfolioFetch('unit_directory', {
		unit_visibility: 'active',
		properties: { properties_ids: appfolioIds },
		columns: UNIT_COLUMNS
	});
	console.error(`AppFolio returned ${afRows.length} unit rows`);

	// 4. Build review payload: group by property, one row per AppFolio unit.
	// First, pre-group AppFolio rows by property so we can compute per-property
	// sibling-address counts (needed for fallback when units share an address).
	const afByPropertyId = new Map();
	for (const af of afRows) {
		const propId = String(af.property_id);
		if (!propByAppfolioId.has(propId)) continue;
		if (!afByPropertyId.has(propId)) afByPropertyId.set(propId, []);
		afByPropertyId.get(propId).push(af);
	}

	const byProperty = new Map();
	for (const [propId, afUnits] of afByPropertyId) {
		const prop = propByAppfolioId.get(propId);
		// Count sibling units that parse to the same STREET (ignoring suffix).
		// Used to detect "the address didn't disambiguate" cases — e.g. 50 Rose
		// Ave where 6/9 units have unit-less addresses.
		const siblingStreetCounts = new Map();
		for (const af of afUnits) {
			const parsed = parseUnitAddress(af.unit_address);
			if (!parsed?.street) continue;
			siblingStreetCounts.set(parsed.street, (siblingStreetCounts.get(parsed.street) ?? 0) + 1);
		}
		byProperty.set(prop.id, {
			bedrock_property_id: prop.id,
			property_name: prop.name,
			appfolio_property_id: prop.appfolio_property_id,
			appfolio_property_number: prop.appfolio_property_number,
			units: afUnits.map((af) => {
				const bedrockUnit = bedrockUnitByAppfolioId.get(String(af.unit_id));
				return {
					appfolio_unit_id: String(af.unit_id),
					appfolio_unit_name: af.unit_name ?? null,
					appfolio_unit_address: af.unit_address ?? null,
					bedrock_unit_id: bedrockUnit?.id ?? null,
					bedrock_current_name: bedrockUnit?.name ?? null,
					proposed_name: deriveProposedName(af, prop, siblingStreetCounts, afUnits.length)
				};
			})
		});
	}

	// 6. Bedrock units that have NO matching AppFolio unit (deleted on AppFolio side?).
	const propByBedrockId = new Map(propRows.map((p) => [p.id, p]));
	const afUnitIds = new Set(afRows.map((af) => String(af.unit_id)));
	const orphans = [];
	for (const u of unitRows) {
		if (u.appfolio_unit_id && !afUnitIds.has(String(u.appfolio_unit_id))) {
			const prop = propByBedrockId.get(u.property_id);
			orphans.push({
				bedrock_unit_id: u.id,
				bedrock_property_id: u.property_id,
				property_name: prop?.name ?? null,
				appfolio_property_id: prop?.appfolio_property_id ?? null,
				appfolio_property_number: prop?.appfolio_property_number ?? null,
				name: u.name,
				appfolio_unit_id: u.appfolio_unit_id
			});
		}
	}
	orphans.sort((a, b) => (a.property_name ?? '').localeCompare(b.property_name ?? ''));
	console.error(`Orphan units (in Bedrock, missing on AppFolio): ${orphans.length}`);

	const properties = [...byProperty.values()].sort((a, b) => a.property_name.localeCompare(b.property_name));
	const payload = {
		generated_at: new Date().toISOString(),
		workspace: { id: workspaceId, label: WORKSPACE_LABEL },
		stats: {
			properties: properties.length,
			units_appfolio: afRows.length,
			units_bedrock: unitRows.length,
			orphans: orphans.length
		},
		properties,
		orphans
	};

	await fs.mkdir(path.dirname(OUT), { recursive: true });
	await fs.writeFile(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
	console.error(`\nWrote ${OUT}`);
	console.error(`  ${properties.length} properties · ${afRows.length} AppFolio units · ${orphans.length} orphans`);
}

main().catch((err) => {
	console.error('FAILED:', err.message);
	process.exit(1);
});
