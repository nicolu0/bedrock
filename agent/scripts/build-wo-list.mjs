// Render every crawled work order as a searchable HTML table with a
// "copy as TSV" button — so Andrew can browse them or paste the whole set
// (or a filtered slice) to the agent as context.
//
//   node scripts/build-wo-list.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRAWL_DIR = path.resolve(HERE, '../appfolio/crawl');
const ARTIFACTS = path.resolve(HERE, '../../.claude/artifacts');

const wf = fs.readdirSync(CRAWL_DIR).filter((f) => /^greenoak-wos-.*\.json$/.test(f)).sort().pop();
if (!wf) throw new Error('no greenoak-wos-*.json — run the crawl first');
const wos = JSON.parse(fs.readFileSync(path.join(CRAWL_DIR, wf), 'utf8'));

// newest first
const rows = wos.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
const COLS = [
	['wo_number', 'WO#'], ['created_at', 'Date'], ['status', 'Status'],
	['property', 'Property'], ['unit', 'Unit'], ['tenant', 'Tenant'],
	['category', 'Trade'], ['vendor', 'Vendor'], ['description', 'Description']
];
// trim the date to YYYY-MM-DD for display
for (const r of rows) r._date = String(r.created_at || '').slice(0, 10);

const data = rows.map((r) => ({
	wo_number: r.wo_number, created_at: r._date, status: r.status,
	property: (r.property || '').split(' - ')[0], unit: r.unit, tenant: r.tenant,
	category: r.category, vendor: r.vendor, description: r.description, wo_url: r.wo_url
}));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Green Oak — all work orders</title>
<style>
:root{--bg:#000;--fg:#fff;--card:#0d0d0d;--line:#2a2a2a;--muted:#9a9a9a;--accent:#fff;--accent-fg:#000;--hover:rgba(255,255,255,0.06)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px}
.wrap{max-width:1400px;margin:0 auto;padding:28px 22px 100px}
h1{font-size:24px;font-weight:800;margin:0 0 2px;letter-spacing:-0.02em}
.sub{color:var(--muted);font-size:13px;margin:0 0 16px}
.bar{position:sticky;top:0;background:var(--bg);padding:10px 0;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--line);z-index:5;flex-wrap:wrap}
input,select{background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 12px;font-size:13px}
input#q{flex:1;min-width:220px}
button{background:var(--accent);color:var(--accent-fg);border:0;border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer}
.count{color:var(--muted);font-size:12px;white-space:nowrap}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12.5px}
th,td{text-align:left;padding:6px 9px;border-bottom:1px solid #1a1a1a;vertical-align:top}
th{position:sticky;top:54px;background:var(--bg);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.04em;cursor:pointer;white-space:nowrap}
tr:hover td{background:var(--hover)}
td:nth-child(1){font-weight:700;white-space:nowrap}
td:nth-child(2){white-space:nowrap;color:var(--muted)}
td.desc{max-width:420px}
a{color:var(--accent)}
.pill{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
</style></head><body><div class="wrap">
<h1>Green Oak — all work orders</h1>
<p class="sub">${data.length} work orders · newest first · source <code>appfolio/crawl/${wf}</code></p>
<div class="bar">
  <input id="q" placeholder="Search — WO#, property, vendor, tenant, description…">
  <select id="status"><option value="">All statuses</option></select>
  <span class="count" id="count"></span>
  <button id="copy">Copy visible as TSV</button>
</div>
<table><thead><tr>${COLS.map(([k, l]) => `<th data-k="${k}">${l}</th>`).join('')}<th>Link</th></tr></thead><tbody id="tb"></tbody></table>
<script>
const DATA = ${JSON.stringify(data)};
const COLS = ${JSON.stringify(COLS)};
const tb = document.getElementById('tb'), q = document.getElementById('q'), sel = document.getElementById('status'), count = document.getElementById('count');
let sortK = 'created_at', sortDir = -1;
[...new Set(DATA.map(d => d.status).filter(Boolean))].sort().forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
function filtered(){
  const term = q.value.toLowerCase().trim(), st = sel.value;
  let r = DATA.filter(d => (!st || d.status===st) && (!term || COLS.some(([k]) => String(d[k]??'').toLowerCase().includes(term))));
  r.sort((a,b)=> String(a[sortK]??'').localeCompare(String(b[sortK]??''), undefined, {numeric:true}) * sortDir);
  return r;
}
function render(){
  const r = filtered();
  count.textContent = r.length + ' of ' + DATA.length;
  tb.innerHTML = r.map(d => '<tr>' + COLS.map(([k]) => '<td' + (k==='description'?' class="desc"':'') + '>' + (k==='status'?'<span class="pill">'+esc(d[k])+'</span>':esc(d[k])) + '</td>').join('') + '<td>' + (d.wo_url?'<a href="'+d.wo_url+'" target="_blank">open</a>':'') + '</td></tr>').join('');
}
q.oninput = render; sel.onchange = render;
document.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => { const k = th.dataset.k; sortDir = (sortK===k? -sortDir : 1); sortK = k; render(); });
document.getElementById('copy').onclick = async () => {
  const r = filtered();
  const head = COLS.map(([,l])=>l).join('\\t');
  const body = r.map(d => COLS.map(([k]) => String(d[k]??'').replace(/[\\t\\n]/g,' ')).join('\\t')).join('\\n');
  await navigator.clipboard.writeText(head + '\\n' + body);
  const b = document.getElementById('copy'); b.textContent = 'Copied ' + r.length + ' rows'; setTimeout(()=>b.textContent='Copy visible as TSV', 1500);
};
render();
</script>
</div></body></html>`;

fs.mkdirSync(ARTIFACTS, { recursive: true });
const out = path.join(ARTIFACTS, '2026-06-01-green-oak-work-orders.html');
fs.writeFileSync(out, html);
console.log(`✓ wrote ${out} (${data.length} work orders)`);
