#!/usr/bin/env node
// Render the per-session entity extraction log into a human-readable
// markdown report for the walkthrough step of PR1 of the memory-graph
// rebuild.
//
// Reads agent/data/phase-entities-log.jsonl (written by backfill-from-chat.mjs
// during phase entities). One session block per session, listing:
//   - LLM-emitted entity mentions (kind + name)
//   - Resolved entities (with status: new vs existing, legacy ref or informal)
//   - Cascaded owners (with reason — which property they came from)
//   - Cascade misses (property emitted but no legacy match or no owner rows)
//
// Writes to stdout by default. Pass --out=PATH to write to a file.
// No LLM calls, no Supabase calls — only reads the local JSONL log.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(HERE, '..');
const LOG_PATH = path.join(AGENT_ROOT, 'data', 'phase-entities-log.jsonl');

const args = process.argv.slice(2);
function arg(name) {
	for (const a of args) {
		if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
		if (a === `--${name}`) return true;
	}
	return null;
}
const outPath = arg('out');

async function main() {
	let raw;
	try {
		raw = await fs.readFile(LOG_PATH, 'utf8');
	} catch (err) {
		console.error(`could not read ${LOG_PATH}: ${err.message}`);
		console.error('did you run --phase=entities yet?');
		process.exit(1);
	}

	const lines = raw.split('\n').filter((l) => l.trim());
	const entries = [];
	for (const line of lines) {
		try {
			entries.push(JSON.parse(line));
		} catch (err) {
			console.error(`skipping malformed log line: ${err.message}`);
		}
	}

	if (entries.length === 0) {
		console.error('log is empty');
		process.exit(1);
	}

	const lines_out = [];
	const push = (s = '') => lines_out.push(s);

	push(`# Phase entities walkthrough`);
	push(``);
	push(`Generated ${new Date().toISOString()} from \`${path.relative(AGENT_ROOT, LOG_PATH)}\``);
	push(`(${entries.length} sessions)`);
	push(``);

	// ── overall stats ─────────────────────────────────────────────────────────

	const totals = {
		sessions_with_entities: 0,
		llm_mentions: 0,
		resolved: 0,
		new_entities: 0,
		cascaded: 0,
		cascade_misses_no_ref: 0,
		cascade_misses_no_owner: 0
	};
	const byKind = { vendor: 0, property: 0, owner: 0 };
	const byName = new Map(); // "kind:name" → mention count across sessions

	for (const e of entries) {
		if (e.llm_emitted.length > 0) totals.sessions_with_entities++;
		totals.llm_mentions += e.llm_emitted.length;
		totals.resolved += e.resolved.length;
		for (const r of e.resolved) {
			if (r.created) totals.new_entities++;
			if (byKind[r.kind] !== undefined) byKind[r.kind]++;
			const key = `${r.kind}:${r.name}`;
			byName.set(key, (byName.get(key) ?? 0) + 1);
		}
		totals.cascaded += e.cascaded.length;
		for (const m of e.cascade_misses) {
			if (m.reason === 'no_legacy_ref_id') totals.cascade_misses_no_ref++;
			else if (m.reason === 'no_owner_properties_rows') totals.cascade_misses_no_owner++;
		}
	}

	push(`## Summary`);
	push(``);
	push(`- **Sessions with entities:** ${totals.sessions_with_entities}/${entries.length}`);
	push(`- **LLM mentions:** ${totals.llm_mentions}`);
	push(`- **Resolutions (incl. cascades):** ${totals.resolved + totals.cascaded}`);
	push(`- **New entities created:** ${totals.new_entities + entries.reduce((n, e) => n + e.cascaded.filter((c) => c.created).length, 0)}`);
	push(`- **Cascaded owners (from properties):** ${totals.cascaded}`);
	push(`- **Cascade misses — property not in legacy table:** ${totals.cascade_misses_no_ref}`);
	push(`- **Cascade misses — property has no owner_properties row:** ${totals.cascade_misses_no_owner}`);
	push(``);
	push(`Resolved entities by kind: vendor=${byKind.vendor}, property=${byKind.property}, owner=${byKind.owner}`);
	push(``);

	// Most-mentioned entities across sessions (rough signal of importance).
	const topMentions = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
	push(`### Most-mentioned entities (across sessions)`);
	push(``);
	for (const [key, n] of topMentions) push(`- \`${key}\` × ${n}`);
	push(``);

	// ── per-session blocks ────────────────────────────────────────────────────

	push(`## Sessions`);
	push(``);

	let i = 1;
	for (const e of entries) {
		const dateStr = (e.started_at || '').slice(0, 16);
		const summary = (e.summary || '').replace(/\s+/g, ' ').trim();
		push(`### ${i}/${entries.length} — \`${e.session_id.slice(0, 8)}\` — ${dateStr}`);
		push(``);
		if (summary) push(`> ${summary}`);
		push(``);
		push(`*${e.message_count} messages*`);
		push(``);

		if (e.llm_emitted.length === 0) {
			push(`(no entities extracted)`);
			push(``);
			i++;
			continue;
		}

		// LLM emitted (what the model said it saw).
		push(`**LLM emitted (${e.llm_emitted.length}):**`);
		for (const x of e.llm_emitted) push(`- ${x.kind}: ${x.name}`);
		push(``);

		// Resolved (find-or-create result per LLM mention).
		push(`**Resolved (${e.resolved.length}):**`);
		for (const r of e.resolved) {
			const llmDiff = r.llm_name && r.llm_name !== r.name ? ` _(llm said: "${r.llm_name}")_` : '';
			const ref = r.ref_table
				? ` → legacy \`${r.ref_table}\``
				: ` _(informal)_`;
			const status = r.created ? ` **new**` : '';
			push(`- ${r.kind}: \`${r.name}\`${ref}${status}${llmDiff}`);
		}
		push(``);

		// Cascaded owners from properties.
		if (e.cascaded.length > 0) {
			push(`**Cascaded owners (${e.cascaded.length}):**`);
			for (const c of e.cascaded) {
				const status = c.created ? ` **new**` : '';
				push(`- owner: \`${c.name}\`${status} ← from property \`${c.from_property_name}\``);
			}
			push(``);
		}

		// Cascade misses.
		if (e.cascade_misses.length > 0) {
			push(`**Cascade misses (${e.cascade_misses.length}):**`);
			for (const m of e.cascade_misses) {
				push(`- property: \`${m.property_name}\` — reason: ${m.reason}`);
			}
			push(``);
		}

		i++;
	}

	const text = lines_out.join('\n') + '\n';
	if (outPath) {
		await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
		await fs.writeFile(outPath, text);
		console.error(`wrote ${outPath}`);
	} else {
		process.stdout.write(text);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
