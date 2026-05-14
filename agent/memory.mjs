// Memory primitives for the agent.
// Per-handle JSON-file storage:
//   data/<handle>/profile.json       — canonical slug → value
//   data/<handle>/observations.jsonl — append-only fuzzy notes

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Honors BEDROCK_DATA_DIR so the eval harness redirects per-handle memory
// reads/writes to a temp directory without touching real prod data/handles.
const DATA_DIR = process.env.BEDROCK_DATA_DIR || path.join(__dirname, 'data');

function handleDir(handle) {
	return path.join(DATA_DIR, handle.replace(/[^\w@+.-]/g, '_'));
}

async function ensureDir(p) {
	await fs.mkdir(p, { recursive: true });
}

export async function getProfile(handle, slug) {
	const file = path.join(handleDir(handle), 'profile.json');
	let profile = {};
	try {
		profile = JSON.parse(await fs.readFile(file, 'utf8'));
	} catch { /* no file yet */ }
	if (slug !== undefined) return profile[slug] ?? null;
	return profile;
}

export async function updateProfile(handle, slug, value) {
	const dir = handleDir(handle);
	await ensureDir(dir);
	const file = path.join(dir, 'profile.json');
	let profile = {};
	try {
		profile = JSON.parse(await fs.readFile(file, 'utf8'));
	} catch { /* new file */ }
	if (value === null || value === undefined || value === '') {
		delete profile[slug];
	} else {
		profile[slug] = value;
	}
	await fs.writeFile(file, JSON.stringify(profile, null, 2), 'utf8');
	return profile;
}

export async function addObservation(handle, content, tags = []) {
	const dir = handleDir(handle);
	await ensureDir(dir);
	const file = path.join(dir, 'observations.jsonl');
	const entry = { ts: new Date().toISOString(), content, tags };
	await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
	return entry;
}

export async function listObservations(handle, limit = 50) {
	const file = path.join(handleDir(handle), 'observations.jsonl');
	let raw;
	try {
		raw = await fs.readFile(file, 'utf8');
	} catch {
		return [];
	}
	const lines = raw.split('\n').filter(Boolean);
	return lines.slice(-limit).map(l => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);
}

// Naive keyword recall — substring match, ranked by hit count.
// Swap for embeddings later.
export async function recall(handle, query, limit = 5) {
	const obs = await listObservations(handle, 500);
	const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return obs.slice(-limit);
	const scored = obs.map(o => {
		const text = (o.content + ' ' + (o.tags || []).join(' ')).toLowerCase();
		let score = 0;
		for (const t of terms) if (text.includes(t)) score++;
		return { o, score };
	}).filter(x => x.score > 0);
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map(x => x.o);
}

// List all properties recorded for this handle (from profile slugs `property/<slug>`).
export async function listProperties(handle) {
	const profile = await getProfile(handle);
	return Object.keys(profile)
		.filter(k => k.startsWith('property/'))
		.map(k => k.slice('property/'.length))
		.filter(Boolean);
}

// List all vendors recorded for this handle, optionally filtered by property and/or trade.
// Slugs are `vendor/<trade>/<property-slug>` → vendor name.
export async function listVendors(handle, filters = {}) {
	const profile = await getProfile(handle);
	const out = [];
	for (const [k, v] of Object.entries(profile)) {
		if (!k.startsWith('vendor/')) continue;
		const parts = k.slice('vendor/'.length).split('/');
		if (parts.length !== 2) continue;
		const [trade, property] = parts;
		if (filters.trade && filters.trade !== trade) continue;
		if (filters.property && filters.property !== property) continue;
		out.push({ trade, property, name: v });
	}
	return out;
}

export async function resetHandle(handle) {
	try {
		await fs.rm(handleDir(handle), { recursive: true });
	} catch { /* nothing to remove */ }
}
