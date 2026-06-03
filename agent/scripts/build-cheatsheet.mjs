// Turn the crawled work orders + vendor-trade enrichment into the Green Oak
// dispatch cheat sheet (HTML artifact). Trade is taken from AppFolio's
// authoritative "Vendor Trade" where the vendor has one (~26 vendors, the
// high-volume ones); for vendors AppFolio left untagged we infer from the
// vendor name + their job descriptions.
//
//   node scripts/build-cheatsheet.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRAWL_DIR = path.resolve(HERE, '../appfolio/crawl');
const ARTIFACTS = path.resolve(HERE, '../../.claude/artifacts');

const INTERNAL = /green oak property management/i;
const CANCELED = /cancel/i;
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// Trade facts Andrew told us that AppFolio doesn't capture. `inhouse` = staff
// (paid 1099 but internal); the rest are authoritative trade overrides. Keyed
// by norm(name). These become memory-graph beliefs when we seed the graph.
const OVERRIDE = new Map([
	['yesikaduarte', { trade: 'Cleaning', inhouse: true }],
	['josgonzalez', { trade: 'Handyperson', inhouse: true }],
	['bondyserviceinc', { trade: 'Laundry' }],
	['safetycentric', { trade: 'Locks/Doors' }],
	['rightwayapartmentservice', { trade: 'Handyperson' }],
	['jesusdelacruz', { trade: 'Landscaping' }],
	['robertocarvalho', { trade: 'Handyperson' }],
	['haykg', { trade: 'Handyperson' }],
	['firstonsite', { trade: 'Restoration' }],
	['shinemaintenance', { trade: 'Handyperson' }],
	['unifiedcommunicationsintegratorsllc', { trade: 'Telecom' }] // internet/routers + entry-door keypads
]);

const TRADES = [
	['Plumbing', /plumb|toilet|leak|faucet|drain|water heater|\bpipe|sink|sewer|garbage disposal|clog|shower|tub|\bwater\b/i],
	['Appliances', /appliance|fridge|refrigerat|dishwasher|washer|dryer|stove|oven|microwave|\brange\b|ice maker|disposal/i],
	['HVAC', /hvac|\bac\b|a\/c|air ?condition|\bheat|furnace|thermostat|cooling|mini ?split/i],
	['Electrical', /electric|outlet|breaker|\blight|wiring|\bswitch|\bpower|gfci|fixture|panel/i],
	['Pest Control', /pest|roach|rodent|mice|\bmouse|\bants?\b|\bbug|exterminat|termite|\bbees?\b|wasp|cockroach|fumigat/i],
	['Roofing', /\broof|gutter/i],
	['Landscaping', /garden|landscap|\blawn|\btree|\bweed|irrigation|sprinkler|yard/i],
	['Pool/Spa', /\bpool|\bspa\b/i],
	['Cleaning', /\bclean|janitor|common area|trash|debris|haul/i],
	['Locks/Doors', /\block|\bkey\b|deadbolt|\blatch|door lever|\bdoor|\bgate|garage door/i],
	['Painting', /\bpaint/i],
	['Flooring', /carpet|floor|\btile|vinyl|laminate/i],
	['Windows', /window|screen|glass/i],
	['Handyperson', /handy|general|\brepair|\bfix|install|patch|misc|maintenance/i]
];
function inferTrade(text) {
	for (const [name, re] of TRADES) if (re.test(text)) return name;
	return 'Other/Unclassified';
}

// High-confidence trade from the vendor NAME (a vendor called "X Pools" is
// Pool/Spa regardless of what any one work order says). Specific → general.
const NAME_TRADE = [
	['Pool/Spa', /\bpool|\bspa\b|jacuzzi|aquatic/i],
	['Pest Control', /pest|exterminat|termite|fumigat|\bbugs?\b|rodent/i],
	['Roofing', /\broof|rain ?gutter|\bgutter/i],
	['Plumbing', /plumb|rooter|\bdrain|sewer|\bseptic|water ?heater/i],
	['HVAC', /\bhvac\b|heating|air ?conditioning|&\s*air\b|\bcooling\b|\bmechanical\b/i],
	['Electrical', /\belectric/i],
	['Landscaping', /landscap|\btree\b|garden|\blawn|nursery/i],
	['Appliances', /appliance|\bwasher|\bdryer|refrigerat|laundry/i],
	['Windows', /\bglass|\bwindow|reglaze/i],
	['Painting', /\bpaint/i],
	['Locks/Doors', /locksmith|garage ?door|overhead door/i],
	['Cleaning', /\bcleaning\b|janitor|\bmaid/i],
	['Flooring', /\bcarpet|flooring|hardwood|\btile\b/i],
	['Fire/Safety', /\bfire\b|extinguisher|\bsprinkler/i],
	['Restoration', /restoration|water ?damage|remediat|environmental/i],
	['Concrete/Masonry', /concrete|masonry|paving|asphalt/i],
	['Handyperson', /handyman|handyperson|general contractor|construction/i]
];
function nameTrade(name) {
	for (const [t, re] of NAME_TRADE) if (re.test(name)) return t;
	return null;
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function latest(re) {
	const files = fs.readdirSync(CRAWL_DIR).filter((f) => re.test(f)).sort();
	return files.length ? path.join(CRAWL_DIR, files[files.length - 1]) : null;
}

const wos = JSON.parse(fs.readFileSync(latest(/^greenoak-wos-.*\.json$/), 'utf8'));
const vendorFile = latest(/^greenoak-vendors-\d{4}-\d\d-\d\d\.json$/); // enrich file only, NOT the resolved-* output
const enrich = vendorFile ? JSON.parse(fs.readFileSync(vendorFile, 'utf8')) : [];
const enrichByName = new Map(); // norm(name) -> {trade, tags, ...}
for (const v of enrich) enrichByName.set(norm(v.name), v);

const actionable = wos.filter((r) => r.vendor && !INTERNAL.test(r.vendor) && !CANCELED.test(r.status));

// per-vendor aggregation
const vendors = new Map(); // name -> {count, props:Set, desc:[]}
for (const r of actionable) {
	if (!vendors.has(r.vendor)) vendors.set(r.vendor, { count: 0, props: new Set(), desc: [] });
	const v = vendors.get(r.vendor);
	v.count++;
	if (r.property) v.props.add(r.property);
	if (r.description) v.desc.push(r.description);
}

// per-vendor trade(s): in-house override → AppFolio Vendor Trade → trade-like Tags → inferred.
function tradesFor(name) {
	const k = norm(name);
	const o = OVERRIDE.get(k);
	if (o) return { trades: [o.trade], src: o.inhouse ? 'inhouse' : 'known' };
	const e = enrichByName.get(k);
	if (e?.trade) return { trades: e.trade.split(/\s*,\s*/).filter(Boolean), src: 'appfolio' };
	if (e?.tags) {
		// a tag that maps to a real trade (e.g. "window repairs"); ignore generic "Contractor"
		const tagTrades = [...new Set(e.tags.split(/\s*,\s*/).map((t) => inferTrade(t)).filter((t) => t !== 'Other/Unclassified'))];
		if (tagTrades.length) return { trades: tagTrades, src: 'tag' };
	}
	const byName = nameTrade(name);
	if (byName) return { trades: [byName], src: 'name' };
	// last resort: work-order description keywords (low confidence — flagged ~)
	const v = vendors.get(name);
	return { trades: [inferTrade((v?.desc || []).slice(0, 20).join(' '))], src: 'inferred' };
}

function mark(name) {
	const s = tradesFor(name).src;
	if (s === 'inferred') return ' <span class="inf">~</span>';
	if (s === 'inhouse') return ' <span class="ih">in-house</span>';
	return '';
}

// trade -> Map(vendor -> count)
const byTrade = new Map();
for (const [name, v] of vendors) {
	for (const t of tradesFor(name).trades) {
		if (!byTrade.has(t)) byTrade.set(t, new Map());
		byTrade.get(t).set(name, v.count);
	}
}

// property -> Map(vendor -> count)
const byProperty = new Map();
for (const r of actionable) {
	if (!r.property) continue;
	if (!byProperty.has(r.property)) byProperty.set(r.property, new Map());
	byProperty.get(r.property).set(r.vendor, (byProperty.get(r.property).get(r.vendor) || 0) + 1);
}

const topOf = (m, n = 99) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const tradeOrder = [...byTrade.entries()]
	.map(([t, m]) => [t, [...m.values()].reduce((a, b) => a + b, 0), m])
	.sort((a, b) => b[1] - a[1]);

const tradeCards = tradeOrder
	.map(([trade, total, m]) => {
		const lis = topOf(m, 6)
			.map(([v, c], i) => `<li${i === 0 ? ' class="best"' : ''}><span>${esc(v)}${mark(v)}</span><b>${c}</b></li>`)
			.join('');
		return `<div class="card"><h3>${esc(trade)} <span class="ct">${total}</span></h3><ul>${lis}</ul></div>`;
	})
	.join('');

const vendorRows = [...vendors.entries()]
	.sort((a, b) => b[1].count - a[1].count)
	.map(([name, v]) => {
		const t = tradesFor(name);
		const txt = esc(t.trades.join(', '));
		const trade =
			t.src === 'inferred' ? `<span class="inf">${txt} ~</span>`
			: t.src === 'inhouse' ? `${txt} <span class="ih">in-house</span>`
			: txt;
		return `<tr><td>${esc(name)}</td><td>${trade}</td><td class="num">${v.count}</td><td class="num">${v.props.size}</td></tr>`;
	})
	.join('');

const propRows = [...byProperty.entries()]
	.sort((a, b) => a[0].localeCompare(b[0]))
	.map(([prop, m]) => {
		const vs = topOf(m, 4).map(([v, c]) => `${esc(v)} <span class="vc">${c}</span>`).join(' · ');
		return `<tr><td>${esc(prop)}</td><td>${vs}</td></tr>`;
	})
	.join('');

const authCount = [...vendors.keys()].filter((n) => ['appfolio', 'tag'].includes(tradesFor(n).src)).length;
const inhouseCount = [...vendors.keys()].filter((n) => tradesFor(n).src === 'inhouse').length;
const internalCount = wos.filter((r) => r.vendor && INTERNAL.test(r.vendor) && !CANCELED.test(r.status)).length;
const canceledCount = wos.filter((r) => CANCELED.test(r.status)).length;
const dates = wos.map((r) => r.created_at).filter(Boolean).sort();
const span = dates.length ? `${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)}` : '—';

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Green Oak — vendor dispatch cheat sheet</title>
<style>
:root{--bg:#000;--fg:#fff;--card:#0d0d0d;--line:#2a2a2a;--muted:#9a9a9a;--accent:#fff;--accent-fg:#000;--done:#4cb782;--hover:rgba(255,255,255,0.06)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.5;font-size:15px}
.wrap{max-width:1000px;margin:0 auto;padding:44px 26px 120px}
h1{font-size:28px;font-weight:800;margin:0 0 4px;letter-spacing:-0.02em}
.sub{color:var(--muted);margin:0 0 20px;font-size:14px}
h2{font-size:20px;font-weight:700;margin:44px 0 6px;padding-top:34px;border-top:1px solid var(--line)}
h2:first-of-type{border-top:0;padding-top:0;margin-top:22px}
.note{color:var(--muted);font-size:13px;margin:0 0 14px;max-width:80ch}
.inf{color:var(--muted);font-style:italic}
.ih{color:var(--done);font-size:10px;font-weight:700;border:1px solid #1d4a36;border-radius:999px;padding:0 6px;margin-left:3px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:110px}
.stat b{display:block;font-size:22px;font-weight:800}
.stat span{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-top:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card h3{margin:0 0 8px;font-size:15px;font-weight:700;display:flex;justify-content:space-between;align-items:center}
.card h3 .ct{color:var(--muted);font-size:12px;font-weight:600}
.card ul{list-style:none;margin:0;padding:0}
.card li{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #161616;color:var(--muted)}
.card li.best{color:var(--fg);font-weight:700}
.card li b{font-variant-numeric:tabular-nums;color:var(--fg)}
.card li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em}
tr:hover td{background:var(--hover)}
td.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:700}
.vc{color:var(--muted);font-size:11px}
code{font-family:ui-monospace,Menlo,monospace;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:12px}
</style></head><body><div class="wrap">

<h1>Green Oak — vendor dispatch cheat sheet</h1>
<p class="sub">From ${wos.length} crawled work orders · ${span} · <code>appfolio/crawl/</code></p>

<div class="stats">
  <div class="stat"><b>${actionable.length}</b><span>real dispatches</span></div>
  <div class="stat"><b>${vendors.size}</b><span>vendors used</span></div>
  <div class="stat"><b>${authCount}</b><span>AppFolio-tagged trade</span></div>
  <div class="stat"><b>${inhouseCount}</b><span>in-house staff</span></div>
  <div class="stat"><b>${byProperty.size}</b><span>properties</span></div>
  <div class="stat"><b>${internalCount}</b><span>self-performed</span></div>
  <div class="stat"><b>${canceledCount}</b><span>canceled (excluded)</span></div>
</div>

<h2>Who to call, by trade</h2>
<p class="note">Trade is AppFolio's authoritative <b>Vendor Trade</b> where set (${authCount} vendors, the high-volume ones); a <span class="inf">~</span> marks one inferred from the vendor's name + job descriptions (AppFolio left it blank). Number = past dispatches; top vendor highlighted.</p>
<div class="grid">${tradeCards}</div>

<h2>Vendor roster <span style="font-weight:400;color:var(--muted);font-size:13px">— ${vendors.size} actually used</span></h2>
<p class="note">The real dispatchable set, not AppFolio's 573-vendor directory. <span class="inf">italic ~</span> = inferred trade. This loads into <code>vendors</code> for Green Oak.</p>
<table><thead><tr><th>Vendor</th><th>Trade</th><th>WOs</th><th>Properties</th></tr></thead><tbody>${vendorRows}</tbody></table>

<h2>By property — who's been used</h2>
<p class="note">Given a property, the vendors dispatched there (most-used first).</p>
<table><thead><tr><th>Property</th><th>Vendors used</th></tr></thead><tbody>${propRows}</tbody></table>

</div></body></html>`;

// machine-readable resolved roster (single source of truth for trade logic) —
// consumed by load-vendors.mjs to populate the vendors table.
const resolved = [...vendors.entries()].map(([name, v]) => {
	const e = enrichByName.get(norm(name));
	const t = tradesFor(name);
	return {
		name,
		appfolio_vendor_id: e?.id ?? null,
		trade: t.trades.join(', '),
		trade_src: t.src,
		wo_count: v.count,
		properties: v.props.size
	};
});
fs.writeFileSync(path.join(CRAWL_DIR, `greenoak-vendors-resolved-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(resolved, null, 2));

fs.mkdirSync(ARTIFACTS, { recursive: true });
const outPath = path.join(ARTIFACTS, '2026-06-01-green-oak-cheatsheet.html');
fs.writeFileSync(outPath, html);
console.log(`✓ wrote ${outPath}`);
console.log(`  ${actionable.length} dispatches · ${vendors.size} vendors (${authCount} AppFolio-tagged) · ${byProperty.size} properties · ${tradeOrder.length} trades`);
