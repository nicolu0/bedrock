// Build a review artifact for the vendors whose trade is still a GUESS
// (AppFolio left them untagged and the name doesn't reveal it). Shows every
// work order each one did, so Andrew can read the actual jobs and decide.
//
//   node scripts/build-guess-review.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRAWL_DIR = path.resolve(HERE, '../appfolio/crawl');
const ARTIFACTS = path.resolve(HERE, '../../.claude/artifacts');
const latest = (re) => {
	const f = fs.readdirSync(CRAWL_DIR).filter((x) => re.test(x)).sort();
	return f.length ? path.join(CRAWL_DIR, f[f.length - 1]) : null;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const resolved = JSON.parse(fs.readFileSync(latest(/^greenoak-vendors-resolved-.*\.json$/), 'utf8'));
const wos = JSON.parse(fs.readFileSync(latest(/^greenoak-wos-\d{4}-\d\d-\d\d\.json$/), 'utf8'));

const guesses = resolved.filter((v) => v.trade_src === 'inferred').sort((a, b) => b.wo_count - a.wo_count);
const byVendor = new Map();
for (const r of wos) {
	if (!r.vendor) continue;
	(byVendor.get(r.vendor) || byVendor.set(r.vendor, []).get(r.vendor)).push(r);
}

const TRADES = ['Plumbing', 'Appliances', 'HVAC', 'Electrical', 'Pest Control', 'Roofing', 'Landscaping', 'Pool/Spa', 'Cleaning', 'Locks/Doors', 'Painting', 'Flooring', 'Windows', 'Fire/Safety', 'Restoration', 'Handyperson', 'Other'];

const sections = guesses.map((g) => {
	const list = (byVendor.get(g.name) || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
	const rows = list.map((r) => `<tr><td>${esc(String(r.created_at).slice(0, 10))}</td><td><span class="pill">${esc(r.status)}</span></td><td>${esc((r.property || '').split(' - ')[0])}${r.unit ? ' · ' + esc(r.unit.replace(/^.* - /, '')) : ''}</td><td>${esc(r.description)}</td></tr>`).join('');
	return `<section>
  <h2>${esc(g.name)} <span class="meta">${list.length} WOs · current guess: <b>${esc(g.trade)}</b></span></h2>
  <table><thead><tr><th>Date</th><th>Status</th><th>Property · Unit</th><th>Job description</th></tr></thead><tbody>${rows}</tbody></table>
</section>`;
}).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Green Oak — vendors that need a trade</title>
<style>
:root{--bg:#000;--fg:#fff;--card:#0d0d0d;--line:#2a2a2a;--muted:#9a9a9a;--accent:#fff;--hover:rgba(255,255,255,0.06);--partial:#f0bf00}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5}
.wrap{max-width:980px;margin:0 auto;padding:40px 24px 120px}
h1{font-size:25px;font-weight:800;margin:0 0 4px;letter-spacing:-0.02em}
.sub{color:var(--muted);font-size:14px;margin:0 0 10px;max-width:80ch}
.opts{color:var(--muted);font-size:12.5px;margin:0 0 26px}
.opts code{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
section{margin:0 0 34px}
h2{font-size:17px;font-weight:700;margin:30px 0 8px;padding-top:22px;border-top:1px solid var(--line)}
h2 .meta{font-weight:400;color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #1a1a1a;vertical-align:top}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.04em}
tr:hover td{background:var(--hover)}
td:nth-child(1){white-space:nowrap;color:var(--muted)}
td:nth-child(3){white-space:nowrap}
.pill{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
</style></head><body><div class="wrap">
<h1>Green Oak — vendors that need a trade</h1>
<p class="sub">${guesses.length} vendors AppFolio never tagged and whose name doesn't reveal the trade. Below is every work order each one did — read the jobs and tell me the trade. Everything else (the other ${resolved.length - guesses.length} vendors) is already authoritative or name-obvious.</p>
<p class="opts">Trade buckets in use: ${TRADES.map((t) => `<code>${t}</code>`).join(' ')}</p>
${sections}
</div></body></html>`;

fs.mkdirSync(ARTIFACTS, { recursive: true });
const out = path.join(ARTIFACTS, '2026-06-01-green-oak-guess-trades.html');
fs.writeFileSync(out, html);
console.log(`✓ wrote ${out} — ${guesses.length} vendors to review`);
