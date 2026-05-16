#!/usr/bin/env node
// UI-only launcher — boots the work-orders / memory dashboard without the
// iMessage poller, dylib IPC, or any of the heavyweight server.mjs plumbing.
//
// Use this when you want to look at the dashboard from a worktree, a laptop,
// or any machine that isn't the Mac mini production host. The drafts/history/
// chat columns will be empty (the underlying log files live with whichever
// agent server has been running), but the Memory tab works fully against the
// live Supabase project.
//
//   node agent/ui-only.mjs                 # port 7879
//   WORK_ORDERS_PORT=7900 node agent/ui-only.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadDotEnv(p) {
	try {
		const raw = await fs.readFile(p, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith('#')) continue;
			const i = t.indexOf('=');
			if (i <= 0) continue;
			const k = t.slice(0, i).trim();
			let v = t.slice(i + 1).trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
				v = v.slice(1, -1);
			}
			if (!(k in process.env)) process.env[k] = v;
		}
	} catch {
		/* optional */
	}
}

// .env precedence: worktree's agent/.env, worktree's repo-root .env. If the
// worktree symlinks these to the main repo, both paths resolve correctly.
await loadDotEnv(path.join(__dirname, '..', '.env'));
await loadDotEnv(path.join(__dirname, '.env'));

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
	console.error('SUPABASE_SERVICE_ROLE_KEY not set.');
	console.error('Tip: symlink the main repo .env files into the worktree once:');
	console.error('  ln -s /Users/andrewchang/work/bedrock/.env .env');
	console.error('  ln -s /Users/andrewchang/work/bedrock/agent/.env agent/.env');
	process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
	console.error('OPENAI_API_KEY not set (memory module needs it to embed)');
	process.exit(1);
}

const { startUi } = await import('./work-orders/ui/index.mjs');

const port = Number(process.env.WORK_ORDERS_PORT ?? 7879);
await startUi({ port, host: '127.0.0.1' });
console.log(`\n  open  →  http://127.0.0.1:${port}/   (Memory tab is the one to test)\n`);
