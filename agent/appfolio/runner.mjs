// Step-gated AppFolio runner — SERVICE mode. Holds one logged-in Chromium and a
// local panel (http://localhost:9773). A run executes ONE step per approval and
// pauses between; the final Send/Save step is GATED — it never fires (yet).
//
// A run is started either from the CLI (back-compat) or by loading the panel URL
// with query params (how agent/ui embeds it via an <iframe>):
//   http://localhost:9773/?flow=text&issue_id=<uuid>&to=Tenant&message=<text>
//   http://localhost:9773/?flow=vendor&srn=7665&vendor=JL%20Unlimited%20Services
// The runner resolves issue_id -> appfolio_srn itself, so the UI stays dumb.
//
// CLI (same as before):
//   node agent/appfolio/runner.mjs --flow vendor --srn 7665 --vendor "JL Unlimited Services"

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, HERE, launch, looksLoggedOut, findConversationsSelect } from './session.mjs';
import { supabaseEnv } from '../core/supabase.mjs';

const PORT = 9773;
// Headless by default: the panel's live screencast is the view, so no Chromium
// window pops over your screen. Set APPFOLIO_HEADED=1 to launch a real window.
const HEADLESS = !process.env.APPFOLIO_HEADED;

function parseFlags(argv) {
	const f = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) continue;
		const k = argv[i].slice(2);
		const v = argv[i + 1];
		if (v === undefined || v.startsWith('--')) f[k] = true;
		else { f[k] = v; i++; }
	}
	return f;
}

async function resolveSrn(issue_id) {
	const { url, key } = supabaseEnv();
	const res = await fetch(`${url}/rest/v1/issues_v2?id=eq.${issue_id}&select=appfolio_srn`, {
		headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`resolveSrn: ${res.status} ${await res.text()}`);
	const rows = await res.json();
	return rows?.[0]?.appfolio_srn;
}

// ---- flows: each step { name, gate?, run(page) } -------------------------

function openStep(srn) {
	return {
		name: `Open work order #${srn}`,
		run: async (p) => {
			await p.goto(`${BASE_URL}/maintenance/service_requests/${srn}`, { waitUntil: 'domcontentloaded' });
			if (await looksLoggedOut(p)) throw new Error('not logged in — run `worker.mjs login` first');
		}
	};
}

// Shared "Texts" steps (used by the standalone text flow and the tail of the
// vendor-dispatch flow). None of these commit — Fill just types into the box.
const expandTextsStep = () => ({
	name: 'Expand Texts',
	run: async (p) => {
		const box = p.getByPlaceholder('Enter message');
		if (!(await box.isVisible().catch(() => false))) {
			await p.getByText('Texts', { exact: true }).first().click().catch(() => {});
		}
		await box.waitFor({ state: 'visible', timeout: 15000 });
	}
});

const selectConversationStep = (to) => ({
	name: `Select conversation → ${to}`,
	run: async (p) => {
		const sel = await findConversationsSelect(p);
		if (!sel) throw new Error('Conversations select not found (custom dropdown?)');
		const opts = await sel.locator('option').allTextContents();
		const m = opts.filter((o) => o.toLowerCase().includes(String(to).toLowerCase()));
		if (m.length !== 1) throw new Error(`recipient "${to}" matched ${m.length} of [ ${opts.join(' | ')} ]`);
		await sel.selectOption({ label: m[0] });
	}
});

const fillMessageStep = (message) => ({
	name: 'Fill message',
	run: async (p) => { await p.getByPlaceholder('Enter message').fill(message); }
});

// LIVE send — clicks the real Send button in the Texts widget.
const sendStep = () => ({
	name: 'Send — texts the recipient (LIVE)',
	run: async (p) => {
		await p.getByRole('button', { name: 'Send', exact: true }).click();
		await p.waitForTimeout(1200);
	}
});

// Standalone messaging: open → expand Texts → pick the conversation → fill →
// SEND (LIVE). Like the vendor flow, the final Send genuinely texts the
// recipient; every step still needs an explicit approval before it runs.
function textFlow({ srn, to, message }) {
	return [
		openStep(srn),
		expandTextsStep(),
		selectConversationStep(to),
		fillMessageStep(message),
		sendStep()
	];
}

// Combined vendor dispatch (LIVE — authorized for real usage):
// open → edit → pick vendor → tick Text+Email secure-link boxes → SAVE (assigns
// the vendor and fires the secure link) → expand Texts → pick the Vendor
// conversation → fill the free-text message → SEND. Each step still needs an
// explicit approval; Save and Send genuinely commit.
function vendorFlow({ srn, vendor, message }) {
	return [
		openStep(srn),
		{
			name: 'Click Edit',
			run: async (p) => {
				await p.locator('.js-edit-work-order').first().click();
				await p.locator('#s2id_maintenance_work_order_party').waitFor({ state: 'visible', timeout: 15000 });
			}
		},
		{
			name: `Select vendor → ${vendor}`,
			run: async (p) => {
				const opener = p.locator('#s2id_maintenance_work_order_party');
				await opener.scrollIntoViewIfNeeded();
				await opener.click();
				const live = p.locator('#select2-drop input').first();
				await live.waitFor({ state: 'visible', timeout: 10000 });
				await live.pressSequentially(vendor, { delay: 60 });
				await p.waitForTimeout(1500);
				const results = p.locator('#select2-drop .select2-results li');
				const texts = (await results.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
				const m = texts.filter((t) => t.toLowerCase().includes(String(vendor).toLowerCase()));
				if (m.length === 0) throw new Error(`vendor "${vendor}" matched 0 of [ ${texts.join(' | ')} ]`);
				await results.filter({ hasText: vendor }).first().click();
			}
		},
		{
			name: 'Tick secure-link boxes (Text + Email)',
			run: async (p) => {
				// These appear only after a vendor is selected (the prior step).
				for (const id of [
					'#maintenance_work_order_send_vendor_text',
					'#maintenance_work_order_send_vendor_wo_link'
				]) {
					const box = p.locator(id);
					await box.waitFor({ state: 'visible', timeout: 10000 });
					await box.check();
				}
			}
		},
		{
			name: 'Save — assigns vendor + sends secure link (LIVE)',
			run: async (p) => {
				await p.locator('#save_button').click();
				await p.waitForLoadState('domcontentloaded').catch(() => {});
				// Wait for the WO view to re-render after the save round-trip.
				await p
					.getByText('Texts', { exact: true })
					.first()
					.waitFor({ state: 'visible', timeout: 20000 })
					.catch(() => {});
			}
		},
		expandTextsStep(),
		selectConversationStep('Vendor'),
		fillMessageStep(message),
		sendStep()
	];
}

// ---- run state (one run at a time) ---------------------------------------

// Live-screencast state (CDP → motion JPEG). Declared up here so ensurePage()
// can reset/re-attach the stream when the browser is relaunched.
let cdp = null;
let lastFrame = null;
const streamClients = new Set();

// Browser session. Relaunchable: if the headed window gets closed, the next run
// (clicking "Send via AppFolio") reopens it via ensurePage().
let browser, context, page;

async function ensurePage() {
	if (page && !page.isClosed() && browser?.isConnected?.()) return false;
	if (browser?.isConnected?.()) await browser.close().catch(() => {});
	const fresh = await launch(HEADLESS);
	browser = fresh.browser;
	context = fresh.context;
	page = fresh.page;
	cdp = null; // any prior screencast died with the old page
	if (streamClients.size) await ensureScreencast().catch(() => {});
	return true;
}
await ensurePage();

let flow = [];
let steps = []; // {name, gate} for the panel
let flowName = 'text';
let idx = 0;
let status = 'idle'; // idle | ready | running | paused | gated | error | done
let error = null;
let shotTs = 0;
let busy = false;
let sig = null;

async function snapshot() {
	await page.screenshot({ path: path.join(HERE, 'run-current.png') }).catch(() => {});
	shotTs = Date.now();
}

// ---- live screencast (CDP → motion JPEG) ---------------------------------
// Pure observation: stream the page surface to the panel as MJPEG so the UI
// shows a live view instead of per-step stills. Started lazily on the first
// /stream client; frames broadcast to every open <img> connection. No deps,
// no WebSocket — a plain <img src="/stream"> renders multipart/x-mixed-replace.
// (State — cdp / lastFrame / streamClients — is declared up top so ensurePage
// can re-attach the stream after a relaunch.)

function writeFrame(res, buf) {
	res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
	res.write(buf);
	res.write('\r\n');
}

async function ensureScreencast() {
	if (cdp) return;
	cdp = await page.context().newCDPSession(page);
	await cdp.send('Page.startScreencast', {
		format: 'jpeg',
		quality: 55,
		maxWidth: 1400,
		maxHeight: 900,
		everyNthFrame: 1
	});
	cdp.on('Page.screencastFrame', async (e) => {
		await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
		lastFrame = Buffer.from(e.data, 'base64');
		for (const res of streamClients) {
			try {
				writeFrame(res, lastFrame);
			} catch {
				streamClients.delete(res);
			}
		}
	});
}

async function startRun(params) {
	await ensurePage(); // reopen the browser if its window was closed
	flowName = params.flow === 'vendor' ? 'vendor' : 'text';
	steps = []; // clear any prior run so a failed start shows a clean error
	idx = 0;
	status = 'starting';
	error = null;
	let srn = params.srn;
	if (!srn && params.issue_id) srn = await resolveSrn(params.issue_id);
	if (!srn) throw new Error('no srn (and issue_id did not resolve to appfolio_srn)');
	flow =
		flowName === 'vendor'
			? vendorFlow({ srn, vendor: params.vendor, message: params.message || '' })
			: textFlow({ srn, to: params.to || 'Tenant', message: params.message || '' });
	steps = flow.map((s) => ({ name: s.name, gate: !!s.gate }));
	idx = 0;
	status = 'ready';
	error = null;
	await snapshot();
	// Auto-run the first step (open the WO) so the browser navigates to the work
	// order the moment the run starts — it's read-only. The rest still gate.
	await runNext();
}

async function runNext() {
	if (busy || status === 'idle') return;
	if (idx >= flow.length || flow[idx].gate) { status = 'gated'; return; }
	busy = true;
	status = 'running';
	try {
		await flow[idx].run(page);
		await snapshot();
		idx++;
		status = idx >= flow.length ? 'done' : flow[idx].gate ? 'gated' : 'paused';
	} catch (e) {
		error = e.message;
		status = 'error';
		await snapshot();
	} finally {
		busy = false;
	}
}

await snapshot();

// CLI back-compat: --flow on the command line starts a run at boot.
const cli = parseFlags(process.argv.slice(2));
if (cli.flow) startRun(cli).catch((e) => { error = e.message; status = 'error'; });

// ---- panel + control endpoints -------------------------------------------

const SHELL = `<!doctype html><meta charset=utf-8><title>AppFolio step runner</title>
<style>
 body{margin:0;background:#16161a;color:#e8e8e6;font:14px/1.5 -apple-system,system-ui,sans-serif}
 .wrap{max-width:560px;margin:0 auto;padding:16px}
 h1{font-size:15px;margin:0 0 2px} .sub{color:#9a9a96;margin:0 0 14px;font-size:12px}
 ol{padding:0;list-style:none;margin:0 0 14px}
 li{display:flex;gap:9px;align-items:center;padding:7px 10px;border:1px solid #2c2c32;border-radius:8px;margin-bottom:5px;background:#1d1d22;font-size:13px}
 .dot{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;flex:0 0 18px}
 .done .dot{background:#1f883d;color:#fff}.cur .dot{background:#a48bff;color:#fff}
 .gate .dot{background:#d29922;color:#16161a}.pend .dot{background:#2c2c32;color:#9a9a96}
 .cur{border-color:#a48bff}.gate{border-color:#d29922} .nm{flex:1}.gate .nm{color:#d29922}
 img{width:100%;border:1px solid #2c2c32;border-radius:9px;display:block;margin-bottom:10px}
 .bar{display:flex;gap:8px;margin:12px 0}
 button{font:600 13px system-ui;padding:9px 16px;border-radius:8px;border:0;cursor:pointer}
 .ap{background:#7a5cff;color:#fff}.ap:disabled{opacity:.4;cursor:not-allowed}
 .rj{background:#2c2c32;color:#f85149} .st{font-size:12px;color:#9a9a96}.err{color:#f85149}
</style>
<div class=wrap>
 <h1 id=title>AppFolio step runner</h1>
 <p class=sub>Approve each step. The final Send/Save is LIVE and will fire.</p>
 <img id=shot src="/shot?t=0">
 <ol id=steps></ol>
 <div class=bar><button class=ap id=ap>Approve next step</button><button class=rj id=rj>Reject / stop</button></div>
 <div class=st id=st></div>
</div>
<script>
async function tick(){
 let s; try{ s=await (await fetch('/state')).json(); }catch{ return; }
 document.getElementById('title').textContent='AppFolio step runner — '+s.flowName+' flow';
 document.getElementById('steps').innerHTML=(s.steps||[]).map((st,i)=>{
  let cls='pend',d=i+1;
  if(i<s.idx){cls='done';d='✓';}else if(st.gate){cls='gate';d='!';}else if(i===s.idx){cls='cur';}
  return '<li class='+cls+'><span class=dot>'+d+'</span><span class=nm>'+st.name+'</span></li>';
 }).join('');
 const stop=['idle','gated','done','error','running'].includes(s.status);
 const ap=document.getElementById('ap');
 ap.disabled=stop; ap.textContent=s.status==='running'?'running…':'Approve next step';
 const msg={idle:'No active run.',ready:'Ready — click Approve to run step 1.',paused:'Step done — approve the next.',running:'Running…',gated:'Reached the gated final step. Nothing sent/saved.',done:'Done — sent/saved via AppFolio.',error:'Error: '+s.error}[s.status]||s.status;
 document.getElementById('st').innerHTML='<span class="'+(s.status==='error'?'err':'')+'">'+msg+'</span>';
 document.getElementById('shot').src='/shot?t='+s.shotTs;
}
document.getElementById('ap').onclick=async()=>{await fetch('/approve',{method:'POST'});};
document.getElementById('rj').onclick=async()=>{await fetch('/reject',{method:'POST'});};
setInterval(tick,1000);tick();
</script>`;

http
	.createServer(async (req, res) => {
		const u = new URL(req.url, `http://localhost:${PORT}`);
		res.setHeader('access-control-allow-origin', '*');

		if (u.pathname === '/') {
			// Start a new run if query params describe one we're not already running.
			if (u.searchParams.get('flow')) {
				const params = Object.fromEntries(u.searchParams.entries());
				const nextSig = JSON.stringify(params);
				if (nextSig !== sig && !busy) {
					sig = nextSig;
					try { await startRun(params); } catch (e) { error = e.message; status = 'error'; }
				}
			}
			res.writeHead(200, { 'content-type': 'text/html' });
			return res.end(SHELL);
		}
		if (u.pathname === '/state') {
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ flowName, steps, idx, status, error, shotTs }));
		}
		if (u.pathname === '/stream') {
			res.writeHead(200, {
				'content-type': 'multipart/x-mixed-replace; boundary=frame',
				'cache-control': 'no-store',
				connection: 'close'
			});
			streamClients.add(res);
			if (lastFrame) writeFrame(res, lastFrame);
			req.on('close', () => streamClients.delete(res));
			ensureScreencast().catch((err) => console.error('screencast:', err.message));
			return;
		}
		if (u.pathname.startsWith('/shot')) {
			const file = path.join(HERE, 'run-current.png');
			if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
			res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
			return res.end(fs.readFileSync(file));
		}
		if (u.pathname === '/approve' && req.method === 'POST') { await runNext(); res.writeHead(200); return res.end('ok'); }
		if (u.pathname === '/reject' && req.method === 'POST') {
			status = 'idle'; sig = null;
			res.writeHead(200); return res.end('ok');
		}
		res.writeHead(404); res.end();
	})
	.listen(PORT, '127.0.0.1', () => {
		console.log(`\nStep runner service ready: http://localhost:${PORT}`);
		console.log('Idle until a run is requested (CLI --flow or a panel URL with ?flow=…). Final Send/Save is GATED.\n');
	});
