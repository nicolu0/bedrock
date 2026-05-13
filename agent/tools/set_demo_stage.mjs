// set_demo_stage — advance the demo state machine. Demo skill only; other
// skills should not expose this tool. Stage transitions trigger different
// stage-specific blocks in the demo's taskPrompt on the next iteration.
//
// Special case: on the in-order followup → complete transition, emit the
// hardcoded closer messages inline and signal endTurn so the orchestrator
// breaks the loop instead of running another iteration (the model would
// otherwise re-enter the new stage prompt and try to greet again).

import * as memory from '../memory.mjs';

const CLOSER = [
	"that's how we'll usually handle work orders.",
	'any questions?'
];
const CLOSER_GAP_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const setDemoStage = {
	name: 'set_demo_stage',
	description:
		'Advance the demo state machine. Stages in order: intro (waiting for confirmation), setup (collecting property + vendor), dispatch (live work order, get approval, send vendor + tenant), learning (ask if this should be the default for similar issues), followup (monitoring + auto-followup pitch), complete (done). Call this when the current stage is finished.',
	parameters: {
		type: 'object',
		properties: {
			stage: {
				type: 'string',
				enum: ['setup', 'dispatch', 'learning', 'followup', 'complete']
			}
		},
		required: ['stage']
	},
	async run({ stage }, ctx) {
		if (!ctx.handle) throw new Error('set_demo_stage: ctx.handle required');
		const priorStage = (await memory.getProfile(ctx.handle, 'system/stage')) || 'intro';
		await memory.updateProfile(ctx.handle, 'system/stage', stage);

		if (priorStage === 'followup' && stage === 'complete') {
			for (let i = 0; i < CLOSER.length; i++) {
				if (ctx.outbox) ctx.outbox.push(CLOSER[i]);
				if (ctx.onEvent) await ctx.onEvent({ type: 'message', content: CLOSER[i] });
				if (i < CLOSER.length - 1) await sleep(CLOSER_GAP_MS);
			}
			return { ok: true, stage, endTurn: true };
		}
		return { ok: true, stage };
	}
};
