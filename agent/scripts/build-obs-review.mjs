// Pair each seeded observation with its source work order, and flag (★) any
// observation whose stored property name isn't the canonical loaded name.
//   node scripts/build-obs-review.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRAWL = path.resolve(HERE, '../appfolio/crawl');
const ARTIFACTS = path.resolve(HERE, '../../.claude/artifacts');

const res = JSON.parse(fs.readFileSync(path.resolve(HERE, '../data/seed-greenoak-dispatch-results.json'), 'utf8'));
const obs = res.results || res.observations || [];
const wf = fs.readdirSync(CRAWL).filter((f) => /^greenoak-wos-\d.*\.json$/.test(f)).sort().pop();
const wos = JSON.parse(fs.readFileSync(path.join(CRAWL, wf), 'utf8'));
const woBy = new Map(wos.map((w) => [w.wo_number, w]));

// 34 canonical property names (from the loaded properties table).
const CANONICAL = ['1040 4th St #402', '115 Ocean Front Walk ', '16064 Jersey St.', '1616 Ashland Ave', '1820 S Barrington', '1827 S Barrington Ave #107', '1926 6th St', '20605 Cheney Dr', '2123 Linnington', '2135 Ivar Ave', '2144 Queensberry Rd.', '2312 West Blvd', '2419 S Cochran Ave', '2621 Carnegie Ln', '33 Sea Colony Dr', '3473 Sabina St.', '350 E 105th St', '4219 Abner St', '4239 Lindblade', '4418 Vantage Ave', '505  N Belmont Ave', '5178 Almont St', '5179 Huntington Dr.', '660 S Allen Ave', '742 N Cherokee', '829 Bunker Hill', '8309 Kirkwood Drive', '831-833 E 109th', '8342 Kirkwood', '8921 Wonderland Park Ave', '9033 Dicks St', '9206 S Hoover St', '9th St Bungalow Home LLC', 'Horizon Ave Duplex'];
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,]+$/, '');
const CN = CANONICAL.map((c) => [c, norm(c)]);
function canonical(p) {
  const np = norm(p);
  if (CN.some(([, n]) => n === np)) return { clean: true, canonical: p };
  const sub = CN.find(([, n]) => np.includes(n) || n.includes(np));
  return { clean: false, canonical: sub ? sub[0].trim() : '?' };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const propShort = (p) => (p || '').split(' - ')[0];
const unitShort = (u) => (u || '').replace(/^.* - /, '');

let offCount = 0;
const rows = obs.map((o) => {
  const w = woBy.get(o.wo) || {};
  const c = canonical(o.property);
  if (!c.clean) offCount++;
  const propLine = c.clean
    ? `<span class="objprop">${esc(o.property)}</span>`
    : `<span class="objprop off">★ ${esc(o.property)}</span><span class="fix">→ canonical: <b>${esc(c.canonical)}</b></span>`;
  return `<tr${c.clean ? '' : ' class="flag"'}>
    <td class="wo">${c.clean ? '' : '<span class="star">★</span>'}<b>${esc(o.wo)}</b><span class="sub">${esc(String(w.created_at || '').slice(0, 10))}</span><span class="pill">${esc(w.status || '?')}</span></td>
    <td class="loc">${esc(propShort(w.property))}${w.unit ? `<span class="sub">${esc(unitShort(w.unit))}</span>` : ''}${w.tenant ? `<span class="sub t">${esc(w.tenant)}</span>` : ''}</td>
    <td class="src">${esc(w.description || '—')}</td>
    <td class="obs"><b>${esc(o.title)}</b><span class="summ">${esc(o.summary)}</span>${propLine}</td>
    <td class="ven">${esc(o.vendor)}<div class="tags">${(o.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></td>
  </tr>`;
}).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Green Oak — observation batch review</title>
<style>
:root{--bg:#000;--fg:#fff;--card:#0d0d0d;--line:#2a2a2a;--muted:#9a9a9a;--accent:#fff;--hover:rgba(255,255,255,0.05);--star:#f0bf00}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.45}
.wrap{max-width:1280px;margin:0 auto;padding:36px 22px 120px}
h1{font-size:24px;font-weight:800;margin:0 0 4px;letter-spacing:-0.02em}
.sub0{color:var(--muted);font-size:13px;margin:0 0 18px;max-width:92ch}
.sub0 b.warn{color:var(--star)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
thead th{position:sticky;top:0;background:var(--bg);text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.04em;padding:8px 10px;border-bottom:1px solid var(--line);z-index:2}
td{padding:10px;border-bottom:1px solid #161616;vertical-align:top}
tr:hover td{background:var(--hover)}
tr.flag td{background:rgba(240,191,0,0.05)}
td.wo{white-space:nowrap}
td.wo b{font-size:13px}
.star{color:var(--star);font-weight:800;margin-right:3px}
.sub{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.sub.t{font-style:italic;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{display:inline-block;margin-top:4px;font-size:9.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
td.loc{min-width:150px;font-weight:600}
td.src{color:#cfcfcf;max-width:330px}
td.obs{max-width:300px}
td.obs b{display:block;color:var(--fg);margin-bottom:3px}
.summ{color:var(--muted)}
.objprop{display:block;margin-top:6px;font-size:11px;color:var(--muted)}
.objprop.off{color:var(--star);font-weight:700}
.fix{display:block;font-size:10.5px;color:var(--muted)}
.fix b{color:var(--fg)}
td.ven{min-width:160px;font-weight:600}
.tags{margin-top:5px;display:flex;flex-wrap:wrap;gap:3px}
.tag{font-size:9.5px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 5px}
code{font-family:ui-monospace,Menlo,monospace;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:11.5px}
</style></head><body><div class="wrap">
<h1>Green Oak — observation batch review</h1>
<p class="sub0">First <b>${obs.length}</b> Jan-1 dispatch observations in the memory graph, each paired with its <b>source work order</b>. Left = raw WO issue; right = the observation (now showing the property name it stored). <b class="warn">★ ${offCount}</b> stored a non-canonical property (city/zip appended) — entities still resolved correctly, but the full run will write the canonical name. The other quirks (<code>#107</code>, double/trailing spaces) match the canonical names as-is. Source: <code>${wf}</code>.</p>
<table>
<thead><tr><th>WO · date · status</th><th>Property · unit · tenant</th><th>Source work-order issue</th><th>Observation (in graph)</th><th>Vendor · tags</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div></body></html>`;

fs.mkdirSync(ARTIFACTS, { recursive: true });
const out = path.join(ARTIFACTS, '2026-06-01-green-oak-obs-review.html');
fs.writeFileSync(out, html);
console.log(`✓ wrote ${out} — ${obs.length} obs, ${offCount} starred (non-canonical property)`);
