// Standalone launcher for THIS worktree's drafts UI, to trial the embedded
// AppFolio step-runner without starting the full agent (no pollers, no iMessage
// bridge). Runs on a spare port and reads the main repo's state dir via
// BEDROCK_STATE_DIR so the same drafts appear. iMessage send is stubbed — the
// AppFolio runner handles *_appfolio drafts; groupchat send is disabled here.
//
//   BEDROCK_STATE_DIR=/Users/andrewchang/work/bedrock/agent/state \
//     node --env-file=.env agent/appfolio/ui-trial.mjs

import { startUi } from '../ui/index.mjs';

const port = Number(process.env.UI_TRIAL_PORT) || 7879;
await startUi({
	port,
	sendIMessage: async () => ({ ok: false, error: 'iMessage send disabled in trial UI' }),
	log: console.log
});
console.log(`trial UI: http://localhost:${port}  (state: ${process.env.BEDROCK_STATE_DIR || 'worktree-local'})`);
