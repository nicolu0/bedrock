// AppFolio Reports API diagnostic — try path versions + auth styles, report
// status + content-type so we can see which combo actually hits the API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.resolve(HERE, '../../.env'), 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (m) env[m[1]] = m[2].trim();
}
const ID = env.APPFOLIO_CLIENT_ID;
const SECRET = env.APPFOLIO_CLIENT_SECRET;
const VHOST = env.APPFOLIO_VHOST || 'lapm.appfolio.com';
const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');

async function probe(label, url, useHeader) {
	try {
		const res = await fetch(url, useHeader ? { headers: { Authorization: AUTH, Accept: 'application/json' } } : { headers: { Accept: 'application/json' } });
		const ct = res.headers.get('content-type') || '';
		const text = await res.text();
		const isJson = ct.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
		console.log(`${label}: ${res.status} ${res.statusText} | ${ct.split(';')[0]} | ${isJson ? 'JSON' : 'HTML/other'} | ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
		return { status: res.status, isJson, text };
	} catch (e) {
		console.log(`${label}: ERROR ${e.message}`);
		return { error: e.message };
	}
}

const userinfo = `https://${encodeURIComponent(ID)}:${encodeURIComponent(SECRET)}@${VHOST}`;
console.log(`vhost=${VHOST} client=${ID?.slice(0, 6)}…\n`);

for (const v of ['v1', 'v2', 'v0']) {
	await probe(`[${v} header] rent_roll`, `https://${VHOST}/api/${v}/reports/rent_roll.json?paginate_results=false`, true);
}
await probe('[v1 userinfo] rent_roll', `${userinfo}/api/v1/reports/rent_roll.json?paginate_results=false`, false);
await probe('[v1 header] tenant_directory', `https://${VHOST}/api/v1/reports/tenant_directory.json?paginate_results=false`, true);
await probe('[v1 header] unit_directory', `https://${VHOST}/api/v1/reports/unit_directory.json?paginate_results=false`, true);
// list available reports (some accounts expose an index)
await probe('[v1 header] reports index', `https://${VHOST}/api/v1/reports.json`, true);
