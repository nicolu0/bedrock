// The unified tool registry — the single source of truth for what the agent
// can do. Every turn loads every tool, regardless of which skill is active.
// Skills become pure prompt overlays; tool scoping lives only in runbook prose
// as suggestions, never as enforcement.
//
// Adding or removing a tool from the agent's surface is one edit to this file.

import { sendText } from './send_text.mjs';
import { sendReaction } from './send_reaction.mjs';
import { draftTenant } from './draft_tenant.mjs';
import { draftVendor } from './draft_vendor.mjs';
import { setVendor } from './set_vendor.mjs';
import { enrichIssue } from './enrich_issue.mjs';
import { readProfile } from './read_profile.mjs';
import { writeProfile } from './write_profile.mjs';
import { readMemory } from './read_memory.mjs';
import { writeMemory } from './write_memory.mjs';

export const ALL_TOOLS = [
	sendText,
	sendReaction,
	draftTenant,
	draftVendor,
	setVendor,
	enrichIssue,
	readProfile,
	writeProfile,
	readMemory,
	writeMemory
];
