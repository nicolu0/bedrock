// use_skill — load a skill's full instructions into this turn.
//
// Mid-turn skill loading. The model sees a skills menu (name + description per
// entry) in the system-reminder on every turn. If a skill it needs isn't yet
// loaded, it calls use_skill(name) and the skill body comes back wrapped in
// <name>...</name> tags. The tag is the "already loaded" marker — the model
// can see the tag in conversation history on later turns and skip a redundant
// re-load.
//
// The orchestrator can also auto-load a skill for an unambiguous trigger event
// before the first LLM iteration via the same registry path, so some turns
// won't see this tool called explicitly. It exists for:
//   - heterogeneous events where the model decides whether a skill applies
//   - mid-turn cross-domain pulls (rare today, but possible)
//   - model-driven discovery when the trigger doesn't pick a skill

import { loadSkill, listSkillNames } from '../core/skills.mjs';

export const useSkill = {
	name: 'use_skill',
	description: `Load a skill's full instructions into this turn. Skills are operational guides for specific workflows (processing a work order, running a demo). The skills menu in the system-reminder lists every available skill with a one-line description.

BLOCKING REQUIREMENT: when the user's message clearly matches one of the available skills, you MUST call use_skill BEFORE generating any other response or tool call. The returned skill body — wrapped in <skill_name>...</skill_name> tags — is your operating procedure for the rest of the turn; treat it as equally authoritative as your system prompt.

If a <skill_name>...</skill_name> tag for the requested skill already appears anywhere in conversation history, that skill is already loaded — do NOT call again. Available skills: ${listSkillNames().join(', ')}.`,
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description:
					'Name of the skill to load — must match one of the entries in the skills menu (e.g. "process_work_order" or "demo").'
			}
		},
		required: ['name']
	},
	async run({ name }) {
		let skill;
		try {
			skill = await loadSkill(name);
		} catch (err) {
			return { error: err.message, available: listSkillNames() };
		}
		// Wrap body in <name>...</name>. This is the "already loaded" marker —
		// future turns can see the tag in conversation history and skip a redundant
		// use_skill call for the same skill.
		const wrapped = `<${skill.name}>\n${skill.body}\n</${skill.name}>`;
		return { body: wrapped };
	}
};
