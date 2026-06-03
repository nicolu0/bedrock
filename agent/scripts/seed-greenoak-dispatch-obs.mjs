#!/usr/bin/env node
// One-shot seed: first ~30 Green Oak work-order DISPATCH observations into the
// memory graph for human review. Real graph writes via memory.addObservation.
//
// NOT idempotent. Run ONCE. Each obs is keyed by source_message_id = wo_number,
// so a re-run would dupe — delete those source_message_ids first if you must.
//
//   node agent/scripts/seed-greenoak-dispatch-obs.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(AGENT_ROOT, '..');

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

await loadDotEnv(path.join(REPO_ROOT, '.env'));
await loadDotEnv(path.join(AGENT_ROOT, '.env'));

for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) {
	if (!process.env[k]) {
		console.error(`env ${k} not set; source the repo .env first`);
		process.exit(2);
	}
}
if (!process.env.PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) {
	console.error('env PUBLIC_SUPABASE_URL or SUPABASE_URL not set');
	process.exit(2);
}

const memory = await import('../core/memory.mjs');

const WORKSPACE = '5406e04f-8e22-4ed8-a54e-a6d08ff45ef7';

// Hand-authored from greenoak-wos-2026-06-02.json, first 30 dispatch WOs
// (created_at >= 2026-01-01, vendor non-empty, vendor != Green Oak PM, status
// !~ cancel), sorted by created_at ascending. Trades pulled from the vendors
// table for this workspace. raw_text is the WO description verbatim.
const OBS = [
	{
		wo: '1234-1',
		vendor: 'Jimmy’s Pool Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Pool service at 742 N Cherokee → Jimmy’s Pool Service',
		summary: 'Jimmy’s Pool Service handled monthly pool cleaning at 742 N Cherokee.',
		raw_text: 'Monthly pool cleaning',
		tags: ['pool', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1235-1',
		vendor: 'Jose Rivera Landscaping',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Landscaping at 742 N Cherokee → Jose Rivera Landscaping',
		summary: 'Jose Rivera Landscaping handled monthly gardening at 742 N Cherokee.',
		raw_text: 'Gardening - Monthly',
		tags: ['landscaping', 'gardening', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1236-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '8921 Wonderland Park Ave Los Angeles, CA 90046',
		status: 'Completed',
		title: 'Dishwasher + leak check at 8921 Wonderland → Garcia’s Handyman',
		summary:
			'Garcia’s Handyman repaired dishwasher soap dispenser, assessed leaks at 8921 Wonderland Park Ave.',
		raw_text:
			'Repair dishwasher soap dispenser pocket and assess leaks in closet, laundry room, and garage',
		tags: ['handyperson', 'dishwasher', 'leak', 'status-resolved']
	},
	{
		wo: '1238-1',
		vendor: 'George HVAC',
		property: '9th St Bungalow Home LLC',
		status: 'Assigned',
		title: 'AC odor at 9th St Bungalow → George HVAC',
		summary: 'George HVAC handled AC foul-odor issue at 9th St Bungalow Home unit 5.',
		raw_text:
			"Hello, I noticed that the maintenance request submitted on 11/13, as well as the one submitted again in December was closed, but the A/C foul odor issue was not fixed. There were technicians that came two separate times to look at the issue and both mentioned that they were going to discuss with the property management company before they fixed but did not come back to fix. Wondering the status of that discussion, as I haven't been able to use the A/C for 7 weeks. Thank you very much",
		tags: ['hvac', 'ac', 'odor', 'vendor-dispatch']
	},
	{
		wo: '1239-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '9206 S Hoover St',
		status: 'Completed',
		title: 'Light bulbs + lock at 9206 S Hoover → Garcia’s Handyman',
		summary:
			'Garcia’s Handyman replaced missing bulbs, swapped bedroom lock for door knob at 9206 S Hoover St.',
		raw_text:
			'Replace missing light bulbs through out the unit. and replace the lock between the two bedrooms with a regular door knob.',
		tags: ['handyperson', 'lighting', 'lock', 'status-resolved']
	},
	{
		wo: '1240-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '1820 S Barrington',
		status: 'Completed',
		title: 'AC install at 1820 S Barrington → Garcia’s Handyman',
		summary: 'Garcia’s Handyman installed new AC at 1820 S Barrington unit 104.',
		raw_text: 'Install new ac',
		tags: ['handyperson', 'ac', 'install', 'status-resolved']
	},
	{
		wo: '1242-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '505  N Belmont Ave',
		status: 'Work Done',
		title: 'Fence bid at 505 N Belmont → Garcia’s Handyman',
		summary: 'Garcia’s Handyman gave fence bid for owner submission at 505 N Belmont Ave.',
		raw_text:
			'Give a bid for the fence one had been done prior if we can get it again I need to submit to the owner.',
		tags: ['handyperson', 'fence', 'bid', 'status-resolved']
	},
	{
		wo: '1246-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '115 Ocean Front Walk',
		status: 'Completed',
		title: 'Smoke detectors at 115 Ocean Front Walk → Garcia’s Handyman',
		summary:
			'Garcia’s Handyman replaced hardwired smoke detectors at 115 Ocean Front Walk, tall ceilings.',
		raw_text:
			'Replace hardwire smoke detectors. Please be sure to bring a tall ladder as this unit has very tall, ceilings and lightbulbs.',
		tags: ['handyperson', 'smoke-detector', 'fire-safety', 'status-resolved']
	},
	{
		wo: '1247-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '1820 S Barrington',
		status: 'Completed',
		title: 'Bathroom reseal at 1820 S Barrington → Garcia’s Handyman',
		summary: 'Garcia’s Handyman resealed bathroom at 1820 S Barrington unit 104.',
		raw_text: 'Bathroom needs to be resealed.',
		tags: ['handyperson', 'bathroom', 'caulking', 'status-resolved']
	},
	{
		wo: '1250-1',
		vendor: 'Rightway Apartment Service',
		property: '1827 S Barrington Ave #107',
		status: 'Scheduled',
		title: 'Fridge seal at 1827 S Barrington → Rightway',
		summary: 'Rightway Apartment Service handled weak fridge door seal at 1827 S Barrington Ave #107.',
		raw_text: 'Fridge seal weak (seal coming off fridge door)',
		tags: ['handyperson', 'fridge', 'appliance', 'vendor-dispatch']
	},
	{
		wo: '1251-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'Shower door seal at 9th St Bungalow → Garcia’s Handyman',
		summary: 'Garcia’s Handyman fixed shower door seal at 9th St Bungalow Home unit 13.',
		raw_text: 'Fix seal in shower doors',
		tags: ['handyperson', 'shower', 'seal', 'status-resolved']
	},
	{
		wo: '1253-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '2135 Ivar Ave',
		status: 'Completed',
		title: 'Disposal leak at 2135 Ivar Ave → Garcia’s Handyman',
		summary:
			'Garcia’s Handyman replaced leaking kitchen sink disposal at 2135 Ivar Ave unit 1.',
		raw_text:
			'Kitchen sink disposal leaking. Under sink area was filled with water. We traced the leak to the bottom of the disposal. Replacement required',
		tags: ['handyperson', 'disposal', 'leak', 'plumbing', 'status-resolved']
	},
	{
		wo: '1256-1',
		vendor: 'Twin Home Experts Consulting LLC',
		property: '4239 Lindblade',
		status: 'Assigned',
		title: 'Rats at 4239 Lindblade → Twin Home Experts',
		summary:
			'Twin Home Experts handled rat infestation in walls and attic at 4239 Lindblade.',
		raw_text:
			"RATS. Just formally submitting this though I know you are aware. Significant rat droppings were found IN the walls by Hector, but it appears the pipes are not the source, for better or worse. I don't know what the next steps are but the rats continue to literally wake us up with noise, and produce noxious, dangerous odors and droppings that we are breathing in. I appreciate all the effort so far – really!!! I know it has not been easy or inexpensive I'm sure – but we are seemingly back at square one in finding where they are coming from and how they are getting into our walls. We are pregnant, which underscores how important it is we mitigate this health risk – to find and stop how they are getting in, and do the necessary remediation in the attic and walls – and resolve this ASAP. Please call us with an update this week.",
		tags: ['pest-control', 'rats', 'rodent', 'vendor-dispatch']
	},
	{
		wo: '1261-1',
		vendor: 'A1 Service Appliances, Inc.',
		property: '9033 Dicks St',
		status: 'Work Done',
		title: 'Washer no cold water at 9033 Dicks St → A1 Service Appliances',
		summary:
			'A1 Service Appliances handled washer/dryer with no cold water at 9033 Dicks St.',
		raw_text:
			'My washer/dryer is perfectly functional but it appears to not have cold water. Even washing on a cold setting will be steamy and hot when opening the door and my colors are bleeding, attached photo of a super obvious example but has happened to several of my lighter garments and towels.',
		tags: ['appliance', 'washer', 'laundry', 'status-resolved']
	},
	{
		wo: '1263-1',
		vendor: 'Reckon & Reckon Plumbing Inc.',
		property: '4418 Vantage Ave',
		status: 'Work Done',
		title: 'Slow shower drain at 4418 Vantage Ave → Reckon & Reckon Plumbing',
		summary:
			'Reckon & Reckon Plumbing cleared slow-draining shower drain at 4418 Vantage Ave unit 1.',
		raw_text:
			'Shower sink clogged. Tried DIY methods and didn’t work. Not fully clogged but water draining extremely slow',
		tags: ['plumbing', 'drain', 'clog', 'shower', 'status-resolved']
	},
	{
		wo: '1265-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '8921 Wonderland Park Ave Los Angeles, CA 90046',
		status: 'Completed',
		title: 'Bathroom faucet at 8921 Wonderland → Garcia’s Handyman',
		summary:
			'Garcia’s Handyman checked bathroom faucet that would not shut off at 8921 Wonderland Park Ave.',
		raw_text: 'Faucet wont shut off in bathroom need to go and check.',
		tags: ['handyperson', 'faucet', 'plumbing', 'status-resolved']
	},
	{
		wo: '1269-1',
		vendor: 'Zakhar Plumbing',
		property: '1820 S Barrington',
		status: 'Completed',
		title: 'Water heater at 1820 S Barrington → Zakhar Plumbing',
		summary: 'Zakhar Plumbing replaced water heater at 1820 S Barrington unit 201.',
		raw_text: 'Replace water heater',
		tags: ['plumbing', 'water-heater', 'status-resolved']
	},
	{
		wo: '1273-1',
		vendor: 'Raptor Appliance Repair',
		property: '4418 Vantage Ave',
		status: 'Completed',
		title: 'Washer not draining at 4418 Vantage Ave → Raptor Appliance Repair',
		summary: 'Raptor Appliance Repair handled laundry washer not draining at 4418 Vantage Ave unit 1.',
		raw_text: 'Laundry washer not draining water',
		tags: ['appliance', 'washer', 'laundry', 'status-resolved']
	},
	{
		wo: '1274-1',
		vendor: 'Rightway Apartment Service',
		property: '2135 Ivar Ave',
		status: 'Assigned',
		title: 'Ceiling lights out at 2135 Ivar Ave → Rightway',
		summary:
			'Rightway Apartment Service handled out ceiling and stairway lights at 2135 Ivar Ave unit 5.',
		raw_text:
			'The ceiling light by the back door as well as the light at the top of the back stairs are both out.',
		tags: ['handyperson', 'lighting', 'electrical', 'vendor-dispatch']
	},
	{
		wo: '1276-1',
		vendor: 'Reckon & Reckon Plumbing Inc.',
		property: '829 Bunker Hill',
		status: 'Completed',
		title: 'Kitchen sink drain at 829 Bunker Hill → Reckon & Reckon Plumbing',
		summary: 'Reckon & Reckon Plumbing cleared kitchen sink not draining at 829 Bunker Hill unit 11.',
		raw_text: 'Kitchen sink not draining',
		tags: ['plumbing', 'drain', 'sink', 'status-resolved']
	},
	{
		wo: '1278-1',
		vendor: 'Yesika Duarte',
		property: '829 Bunker Hill',
		status: 'Completed',
		title: 'Monthly cleaning at 829 Bunker Hill → Yesika Duarte',
		summary: 'Yesika Duarte handled monthly cleaning at 829 Bunker Hill.',
		raw_text: 'Monthly cleaning fee',
		tags: ['cleaning', 'recurring-treatment', 'status-resolved']
	},
	{
		wo: '1279-1',
		vendor: 'Jimmy’s Pool Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Pool service at 742 N Cherokee → Jimmy’s Pool Service',
		summary: 'Jimmy’s Pool Service handled monthly pool cleaning at 742 N Cherokee.',
		raw_text: 'Monthly pool cleaning',
		tags: ['pool', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1281-1',
		vendor: 'Zakhar Plumbing',
		property: '8342 Kirkwood',
		status: 'Assigned',
		title: 'Leaking shower faucet at 8342 Kirkwood → Zakhar Plumbing',
		summary: 'Zakhar Plumbing handled leaking shower faucet at 8342 Kirkwood.',
		raw_text: 'Leaking shower faucet',
		tags: ['plumbing', 'faucet', 'leak', 'shower', 'vendor-dispatch']
	},
	{
		wo: '1283-1',
		vendor: 'Mike Green Fire Protection',
		property: '4418 Vantage Ave',
		status: 'Completed',
		title: 'Fire extinguisher at 4418 Vantage Ave → Mike Green Fire Protection',
		summary:
			'Mike Green Fire Protection installed compliance fire extinguisher at 4418 Vantage Ave.',
		raw_text: 'Install, fire compliance fire extinguisher',
		tags: ['fire-safety', 'fire-extinguisher', 'compliance', 'status-resolved']
	},
	{
		wo: '1284-1',
		vendor: 'Rightway Apartment Service',
		property: '9th St Bungalow Home LLC',
		status: 'Work Done',
		title: 'Flood light sensor at 9th St Bungalow → Rightway',
		summary:
			'Rightway Apartment Service handled bright back-entrance flood light needing sensor at 9th St Bungalow unit 6.',
		raw_text:
			'This is my 3rd request about the bright flood light in the back entrance shining into my apt. Apt 6. There are no other flood lights outside any other apartments on my side. It needs to be on a sensor. It keeps my sleep not great. If this issue cannot be resolved I will have to look for a new apartment so I can get better quality sleep.',
		tags: ['handyperson', 'lighting', 'electrical', 'status-resolved']
	},
	{
		wo: '1290-1',
		vendor: 'FIRST AID APPLIANCE & HVAC PRO',
		property: '829 Bunker Hill',
		status: 'Assigned',
		title: 'AC not working at 829 Bunker Hill → First Aid Appliance & HVAC',
		summary:
			'First Aid Appliance & HVAC Pro handled non-working air conditioner at 829 Bunker Hill unit 6.',
		raw_text:
			'Buenas tardes , el Aire acondicionado no está funcionando, cuando podría a venir a checarlo , apartamento #6',
		tags: ['hvac', 'ac', 'appliance', 'vendor-dispatch']
	},
	{
		wo: '1291-1',
		vendor: 'Zakhar Plumbing',
		property: '8342 Kirkwood',
		status: 'Assigned',
		title: 'Leaking shower faucet at 8342 Kirkwood → Zakhar Plumbing',
		summary: 'Zakhar Plumbing handled leaking shower faucet at 8342 Kirkwood.',
		raw_text: 'Leaking shower faucet',
		tags: ['plumbing', 'faucet', 'leak', 'shower', 'vendor-dispatch']
	},
	{
		wo: '1285-3',
		vendor: 'Rightway Apartment Service',
		property: '1616 Ashland Ave',
		status: 'Assigned',
		title: 'Make-ready punch list at 1616 Ashland Ave → Rightway',
		summary:
			'Rightway Apartment Service handled blinds, grout, outlet covers and door punch list at 1616 Ashland Ave.',
		raw_text:
			'Replace blinds in front bedroom by window. (basic white ones from home depot is fine) Handles on pocket doors Grout in kitchen remove the white caulking paint medicine cabinet in bathroom 4 outlet covers one in laundry room, two in the Livingroom those i want for cables to come through, i want to change the outlet that is a phone jack to a flat cover. handle on pocket doors. check locks on windows',
		tags: ['handyperson', 'make-ready', 'punch-list', 'multi-issue-single-vendor', 'vendor-dispatch']
	},
	{
		wo: '1297-1',
		vendor: 'Rightway Apartment Service',
		property: '9th St Bungalow Home LLC',
		status: 'Work Done',
		title: 'Alley gate at 9th St Bungalow → Rightway',
		summary:
			'Rightway Apartment Service adjusted alley gate door not twisting or self-closing at 9th St Bungalow.',
		raw_text:
			'The building alley gate door is not twisting properly. It also not closing on its own anymore, and tenants are placing a block to prevent it from closing. This needs to be adjusted and handled right away for security concerns.',
		tags: ['handyperson', 'gate', 'security', 'status-resolved']
	},
	{
		wo: '1298-1',
		vendor: 'Rightway Apartment Service',
		property: '1827 S Barrington Ave #107',
		status: 'Completed',
		title: 'Bathroom sink leak at 1827 S Barrington → Rightway',
		summary: 'Rightway Apartment Service fixed leaking bathroom sink at 1827 S Barrington Ave #107.',
		raw_text: 'My bathroom sink is leaking',
		tags: ['handyperson', 'sink', 'leak', 'plumbing', 'status-resolved']
	}
];

console.log(`seeding ${OBS.length} Green Oak dispatch observations into workspace ${WORKSPACE}…`);

let written = 0;
const results = [];
for (const o of OBS) {
	const tags = o.status === 'Completed' && !o.tags.includes('status-resolved')
		? [...o.tags, 'status-resolved']
		: o.tags;
	try {
		const inserted = await memory.addObservation(WORKSPACE, {
			title: o.title,
			summary: o.summary,
			raw_text: o.raw_text,
			entities: [
				{ kind: 'vendor', name: o.vendor, weight: 1 },
				{ kind: 'property', name: o.property, weight: 1 }
			],
			tags,
			salience: 0.5,
			source_message_id: o.wo,
			session_id: null
		});
		written++;
		console.log(`  [+] ${o.wo} → ${inserted.id} | ${o.title}`);
		results.push({
			wo: o.wo,
			title: o.title,
			summary: o.summary,
			vendor: o.vendor,
			property: o.property,
			tags
		});
	} catch (err) {
		console.error(`  [!] ${o.wo} FAILED: ${err.message}`);
		results.push({ wo: o.wo, error: err.message });
	}
}

console.log(`\nDONE: processed=${OBS.length} written=${written}`);
await fs.writeFile(
	path.join(AGENT_ROOT, 'data', 'seed-greenoak-dispatch-results.json'),
	JSON.stringify({ processed: OBS.length, written, results }, null, 2)
);
console.log('results → agent/data/seed-greenoak-dispatch-results.json');
