// Skills registry — single source of truth for which skills exist, where their
// SKILL.md lives, and the cached load/menu accessors the orchestrator uses.
//
// Layout convention (Claude Code-style): each skill is a directory under
// agent/skills/<name>/. The skill body is always SKILL.md inside that directory.
// Sibling files (scripts/, templates/, REFERENCE.md, etc.) are valid and stay
// in the same directory so they can be added later without restructuring.
//
// Frontmatter: a YAML block at the top of SKILL.md with `name` and `description`.
// We only read those two fields — anything else is treated as metadata and ignored.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, '..', 'skills');

// Skill registry: name → directory name under agent/skills/. The SKILL.md path
// is always <dir>/SKILL.md. Add a skill by dropping a folder here and adding
// one line below.
const SKILLS = {
	process_work_order: 'process_work_order',
	demo: 'demo'
};

const cache = new Map(); // name → { name, description, body }

// Minimal frontmatter parser — frontmatter is between two `---` lines at the
// top of the file. We only need `name` and `description`; no need for a full
// YAML library. Returns { frontmatter: {name, description}, body: string }.
function parseFrontmatter(raw) {
	const lines = raw.split('\n');
	if (lines[0]?.trim() !== '---') {
		return { frontmatter: {}, body: raw };
	}
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
	if (end < 0) {
		return { frontmatter: {}, body: raw };
	}
	const fm = {};
	for (const line of lines.slice(1, end)) {
		const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
		if (m) {
			let value = m[2].trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			fm[m[1]] = value;
		}
	}
	const body = lines
		.slice(end + 1)
		.join('\n')
		.replace(/^\n+/, '');
	return { frontmatter: fm, body };
}

export function listSkillNames() {
	return Object.keys(SKILLS);
}

export async function loadSkill(name) {
	if (cache.has(name)) return cache.get(name);
	const dir = SKILLS[name];
	if (!dir) throw new Error(`unknown skill: ${name}`);
	const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
	const raw = await readFile(skillPath, 'utf8');
	const { frontmatter, body } = parseFrontmatter(raw);
	const entry = {
		name: frontmatter.name || name,
		description: frontmatter.description || '',
		body
	};
	cache.set(name, entry);
	return entry;
}

// Returns the menu shown to the model on every turn: array of { name, description }
// for every skill in the registry. Caller decides how to render and whether to
// mark loaded skills.
export async function getMenu() {
	return Promise.all(listSkillNames().map(loadSkill)).then((entries) =>
		entries.map(({ name, description }) => ({ name, description }))
	);
}
