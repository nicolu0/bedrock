#!/usr/bin/env node
// One-shot seed: the REMAINING ~77 Green Oak work-order DISPATCH observations
// into the memory graph (batch 2). The first 30 were seeded by
// seed-greenoak-dispatch-obs.mjs; this batch covers everything else in scope
// (created_at >= 2026-01-01, vendor non-empty, vendor != Green Oak PM, status
// !~ cancel), sorted by created_at ascending, with the 30 already-seeded
// wo_numbers excluded.
//
// Properties are the CANONICAL names from the `properties` table for this
// workspace (not the raw WO property strings). Trades are pulled from the
// `vendors` table for this workspace.
//
// NOT idempotent. Run ONCE. Each obs is keyed by source_message_id = wo_number,
// so a re-run would dupe — delete those source_message_ids first if you must.
//
//   node agent/scripts/seed-greenoak-dispatch-obs-batch2.mjs

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

// Hand-authored from greenoak-wos-2026-06-02.json, the 77 in-scope dispatch WOs
// NOT in the first batch, sorted by created_at ascending. Property = canonical
// `properties` name. Trade tags pulled from the `vendors` table. raw_text is
// the WO description verbatim. 'status-resolved' tag added for Completed.
const OBS = [
	{
		wo: '1299-1',
		vendor: 'Rightway Apartment Service',
		property: '33 Sea Colony Dr',
		status: 'Assigned',
		title: 'Shower grout leak at 33 Sea Colony Dr → Rightway',
		summary:
			'Rightway Apartment Service handled eroded shower grout leaking + mildew at 33 Sea Colony Dr.',
		raw_text:
			'The grout in the shower has eroded to the point that the shower is leaking down into itself. It’s causing a mildew smell in the bathroom and I think it needs to be sealed again before it damages the place further please advise.',
		tags: ['handyperson', 'grout', 'leak', 'shower', 'vendor-dispatch']
	},
	{
		wo: '1300-1',
		vendor: 'Rightway Apartment Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Atrium leak at 742 N Cherokee → Rightway',
		summary: 'Rightway Apartment Service handled glass atrium leak at 742 N Cherokee.',
		raw_text: 'Leak in glass atrium',
		tags: ['handyperson', 'leak', 'roofing', 'vendor-dispatch']
	},
	{
		wo: '1301-1',
		vendor: 'Rightway Apartment Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Roof deck leak at 742 N Cherokee → Rightway',
		summary: 'Rightway Apartment Service handled roof leak on deck at 742 N Cherokee.',
		raw_text: 'Roof leak on deck',
		tags: ['handyperson', 'leak', 'roofing', 'vendor-dispatch']
	},
	{
		wo: '1302-1',
		vendor: 'Rightway Apartment Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Ceiling leak at 742 N Cherokee → Rightway',
		summary: 'Rightway Apartment Service handled ceiling leak from balcony above at 742 N Cherokee.',
		raw_text: 'Ceiling leak from balcony above',
		tags: ['handyperson', 'leak', 'ceiling', 'vendor-dispatch']
	},
	{
		wo: '1303-1',
		vendor: 'Rightway Apartment Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Door leak at 742 N Cherokee → Rightway',
		summary: 'Rightway Apartment Service handled door leak at 742 N Cherokee.',
		raw_text: 'Door leak',
		tags: ['handyperson', 'leak', 'door', 'vendor-dispatch']
	},
	{
		wo: '1304-1',
		vendor: 'Rightway Apartment Service',
		property: '2419 S Cochran Ave',
		status: 'Completed',
		title: 'Roof water heater at 2419 S Cochran → Rightway',
		summary:
			'Rightway Apartment Service fixed non-working roof-deck water heater at 2419 S Cochran Ave.',
		raw_text: 'Water heater not working, on roof deck',
		tags: ['handyperson', 'water-heater', 'plumbing', 'status-resolved']
	},
	{
		wo: '1305-1',
		vendor: 'Rightway Apartment Service',
		property: '4219 Abner St',
		status: 'Assigned',
		title: 'Window mesh + light at 4219 Abner St → Rightway',
		summary:
			'Rightway Apartment Service handled bedroom window mesh repair + out main-bedroom light at 4219 Abner St.',
		raw_text:
			'Window mesh needs to be repaired which is in the 1st bedroom and the window on the right. Also, a light is out in the main bedroom.',
		tags: ['handyperson', 'window', 'lighting', 'multi-issue-single-vendor', 'vendor-dispatch']
	},
	{
		wo: '1307-1',
		vendor: 'Rightway Apartment Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Ceiling leak at 742 N Cherokee → Rightway',
		summary: 'Rightway Apartment Service handled leak from ceiling at 742 N Cherokee.',
		raw_text: 'Leak from ceiling',
		tags: ['handyperson', 'leak', 'ceiling', 'vendor-dispatch']
	},
	{
		wo: '1310-1',
		vendor: 'A1 Service Appliances, Inc.',
		property: '4239 Lindblade',
		status: 'Completed',
		title: 'Ice maker at 4239 Lindblade → A1 Service Appliances',
		summary:
			'A1 Service Appliances serviced recurring non-working ice maker at 4239 Lindblade; known model issue.',
		raw_text:
			"Ice maker isn't working - needs maintenance again. Last time the guy came out, he said this is a known issue with the model and it's not entirely fixable.",
		tags: ['appliance', 'ice-maker', 'fridge', 'status-resolved']
	},
	{
		wo: '1311-1',
		vendor: 'Rightway Apartment Service',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'Gate key copies at 9th St Bungalow → Rightway',
		summary:
			'Rightway Apartment Service made + distributed left-gate key copies to odd units at 9th St Bungalow Home LLC.',
		raw_text:
			'Make copies of keys for the left gate of the property when looking at the buidling from the street. ONLY the tenants on the left side receive this copy of this key. Unit 1, 3, 5, 7, 9,11,13 and distribute keys to each unit. Plus 4 more copies.',
		tags: ['handyperson', 'keys', 'gate', 'status-resolved']
	},
	{
		wo: '1312-1',
		vendor: 'Get Pro Locksmith',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'Back gate lock at 9th St Bungalow → Get Pro Locksmith',
		summary:
			'Get Pro Locksmith fixed sticky back-gate alley lock mechanism at 9th St Bungalow Home LLC.',
		raw_text:
			'The lock to the backgate to the alley seems to be giving multiple tenants issues. It seems to be with the internal mechanism. In order for the key to work you need to push in really hard.',
		tags: ['locks', 'gate', 'lock', 'status-resolved']
	},
	{
		wo: '1313-1',
		vendor: 'Get Pro Locksmith',
		property: '4219 Abner St',
		status: 'Completed',
		title: 'Rekey front + back doors at 4219 Abner St → Get Pro Locksmith',
		summary:
			'Get Pro Locksmith replaced front + back door locks keyed alike at 4219 Abner St.',
		raw_text: 'Replace front door lock and back door lock and have them be used with the same key.',
		tags: ['locks', 'rekey', 'lock', 'status-resolved']
	},
	{
		wo: '1314-1',
		vendor: 'Roberto Carvalho',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'Window leak at 9th St Bungalow → Roberto Carvalho',
		summary: 'Roberto Carvalho fixed leak in/near window at 9th St Bungalow Home LLC unit 1.',
		raw_text: 'There was a leak in through the window or near the window into the unit.',
		tags: ['handyperson', 'leak', 'window', 'status-resolved']
	},
	{
		wo: '1236-2',
		vendor: 'Raptor Appliance Repair',
		property: '8921 Wonderland Park Ave',
		status: 'Work Done',
		title: 'Dishwasher again at 8921 Wonderland → Raptor Appliance Repair',
		summary: 'Raptor Appliance Repair handled still-malfunctioning dishwasher at 8921 Wonderland Park Ave.',
		raw_text: 'Something is still not working with the dishwasher.',
		tags: ['appliance', 'dishwasher', 'status-resolved']
	},
	{
		wo: '1318-1',
		vendor: 'Jimmy’s Pool Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Pool service at 742 N Cherokee → Jimmy’s Pool Service',
		summary: 'Jimmy’s Pool Service handled monthly pool cleaning at 742 N Cherokee.',
		raw_text: 'Monthly pool cleaning',
		tags: ['pool', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1319-1',
		vendor: 'Jose Rivera Landscaping',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Landscaping at 742 N Cherokee → Jose Rivera Landscaping',
		summary: 'Jose Rivera Landscaping handled monthly gardening at 742 N Cherokee.',
		raw_text: 'Gardening - Monthly',
		tags: ['landscaping', 'gardening', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1320-1',
		vendor: 'Primate Pest Elimination',
		property: '2419 S Cochran Ave',
		status: 'Scheduled',
		title: 'Bug control at 2419 S Cochran → Primate Pest Elimination',
		summary:
			'Primate Pest Elimination handled overdue secondary bug-control request at 2419 S Cochran Ave.',
		raw_text:
			'Secondary bug control request. In early January while the property manager was visiting the property next door, my husband shared concerns around the bugs on the property and was assured bug control would be provided. As no service was performed to resolve this item, i created a ticket February 2nd. It is now March 2nd and still this request has not been serviced. Can you please provide insight as to when this request will be filled?',
		tags: ['pest-control', 'bugs', 'vendor-dispatch']
	},
	{
		wo: '1323-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '2123 Linnington',
		status: 'Completed',
		title: 'HVAC vent mold at 2123 Linnington → Garcia’s Handyman',
		summary:
			'Garcia’s Handyman remediated mold in/on HVAC vents at 2123 Linnington.',
		raw_text: 'Mold in some of the HVAC vents and on the outside of vents',
		tags: ['handyperson', 'mold', 'hvac', 'status-resolved']
	},
	{
		wo: '1325-1',
		vendor: 'A1 Service Appliances, Inc.',
		property: '8921 Wonderland Park Ave',
		status: 'Completed',
		title: 'Dryer + dishwasher at 8921 Wonderland → A1 Service Appliances',
		summary:
			'A1 Service Appliances checked under-drying dryer + non-dispensing dishwasher at 8921 Wonderland Park Ave.',
		raw_text:
			'Check dryer, states dryer is not drying properly. Please also check dishwasher tenants says the dispenser is not dispensing soap.',
		tags: ['appliance', 'dryer', 'dishwasher', 'multi-issue-single-vendor', 'status-resolved']
	},
	{
		wo: '1326-1',
		vendor: 'Kaesler Plumbing, Inc',
		property: '8921 Wonderland Park Ave',
		status: 'Assigned',
		title: 'Garbage disposal at 8921 Wonderland → Kaesler Plumbing',
		summary: 'Kaesler Plumbing handled garbage disposal check at 8921 Wonderland Park Ave.',
		raw_text: 'Check garbage disposal',
		tags: ['plumbing', 'disposal', 'vendor-dispatch']
	},
	{
		wo: '1327-1',
		vendor: 'José Gonzalez',
		property: '4219 Abner St',
		status: 'Assigned',
		title: 'Sink mildew + leak at 4219 Abner St → José Gonzalez',
		summary:
			'José Gonzalez checked under-kitchen-sink mildew + potential water leaks at 4219 Abner St.',
		raw_text: 'Please check under kitchen sink for mildew stain and potential water leaks.',
		tags: ['handyperson', 'leak', 'mildew', 'sink', 'vendor-dispatch']
	},
	{
		wo: '1329-1',
		vendor: 'Enterprise Plumbing',
		property: '9206 S Hoover St',
		status: 'Assigned',
		title: 'Red-tagged water heater at 9206 S Hoover → Enterprise Plumbing',
		summary:
			'Enterprise Plumbing handled gas-company red-tagged water heater, no hot water, at 9206 S Hoover St.',
		raw_text:
			'Hello, I need someone out here ASAP. The Gas Company just left and red tag my hot water heater and I don’t have any hot water at this moment.',
		tags: ['plumbing', 'water-heater', 'gas', 'urgent', 'vendor-dispatch']
	},
	{
		wo: '1334-1',
		vendor: 'All City Plumbing Inc',
		property: '4219 Abner St',
		status: 'Completed',
		title: 'Toilet water pressure at 4219 Abner St → All City Plumbing',
		summary:
			'All City Plumbing fixed toilet with poor flush + continuously running water at 4219 Abner St.',
		raw_text:
			'Water pressure - Toilet has trouble flushing smoothly & takes awhile to reset after flushing due to water continuously running',
		tags: ['plumbing', 'toilet', 'status-resolved']
	},
	{
		wo: '1335-1',
		vendor: 'FIRST AID APPLIANCE & HVAC PRO',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'AC won’t turn on at 9th St Bungalow → First Aid Appliance & HVAC',
		summary:
			'First Aid Appliance & HVAC Pro fixed AC that would not power on at 9th St Bungalow Home LLC unit 9.',
		raw_text:
			'Ac is not turning on. I tried replacing batteries in remote. I tried turning on manually with button on unit would not turn on. I tried resetting the breaker. I tried turning it back on with both remote and button and would not turn on.',
		tags: ['hvac', 'ac', 'appliance', 'status-resolved']
	},
	{
		wo: '1337-1',
		vendor: 'Roberto Carvalho',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'Kitchen lighting + holes at 9th St Bungalow → Roberto Carvalho',
		summary:
			'Roberto Carvalho fixed kitchen lighting + patched bathroom holes at 9th St Bungalow Home LLC unit 11.',
		raw_text:
			'Hi there, please can you just fix the lighting in the kitchen between living room and kitchen and also bathroom there’s some holes thank you',
		tags: ['handyperson', 'lighting', 'drywall', 'multi-issue-single-vendor', 'status-resolved']
	},
	{
		wo: '1338-1',
		vendor: 'José Gonzalez',
		property: '3473 Sabina St.',
		status: 'Assigned',
		title: 'Make-ready punch list at 3473 Sabina St. → José Gonzalez',
		summary:
			'José Gonzalez handled multi-item punch list: sink leaks, gate lock, range hood, frame mold, toilet at 3473 Sabina St.',
		raw_text:
			'- Check kitchen sink has leak - Repair sink cabinet - Repair or replace lock on the front door exterior gate door - Replace or repair range hood in kitchen -Repair front door frame/ mold - Repair BATHROOM sink cabinet and leaking pipe - Secure toilet -Secure wall heater cover',
		tags: ['handyperson', 'punch-list', 'leak', 'multi-issue-single-vendor', 'vendor-dispatch']
	},
	{
		wo: '1340-1',
		vendor: 'Reckon & Reckon Plumbing Inc.',
		property: '8921 Wonderland Park Ave',
		status: 'Assigned',
		title: 'Backed-up sink at 8921 Wonderland → Reckon & Reckon Plumbing',
		summary:
			'Reckon & Reckon Plumbing handled backed-up sink + dishwasher check at 8921 Wonderland Park Ave.',
		raw_text: 'Backed up sink check dishwasher',
		tags: ['plumbing', 'drain', 'sink', 'vendor-dispatch']
	},
	{
		wo: '1341-1',
		vendor: 'Reckon & Reckon Plumbing Inc.',
		property: '9033 Dicks St',
		status: 'Completed No Need To Bill',
		title: 'Sewage smell at 9033 Dicks St → Reckon & Reckon Plumbing',
		summary: 'Reckon & Reckon Plumbing handled sewage smell in entry at 9033 Dicks St.',
		raw_text: 'Sewage smell in entry',
		tags: ['plumbing', 'sewage', 'odor', 'vendor-dispatch']
	},
	{
		wo: '1345-1',
		vendor: 'Reckon & Reckon Plumbing Inc.',
		property: '829 Bunker Hill',
		status: 'Completed',
		title: 'Backup drain + toilet at 829 Bunker Hill → Reckon & Reckon Plumbing',
		summary:
			'Reckon & Reckon Plumbing cleared bathtub backing up from drain + non-working toilet at 829 Bunker Hill unit 5.',
		raw_text: 'Bathtub has water coming up out of the drain and my toilet isn’t working.',
		tags: ['plumbing', 'drain', 'toilet', 'status-resolved']
	},
	{
		wo: '1346-1',
		vendor: 'José Gonzalez',
		property: '1616 Ashland Ave',
		status: 'Assigned',
		title: 'Move-in punch list at 1616 Ashland Ave → José Gonzalez',
		summary:
			'José Gonzalez handled move-in issues: no hot water, dead disposals, stove gas, weak AC, dryer at 1616 Ashland Ave.',
		raw_text:
			'Experiencing a few issues upon moving in, sharing urgency/details below. Let us know if you need more details. 1. Hot water is not working — we transferred gas service today so it might take a bit to kick in? Couldn’t locate the fuse box to check if it’s the breaker 2. Garbage Disposal in sinks not working 3. Gas to cook with on stove not working (assume this is also connected to gas not being switched over in our name?) 4. AC running outside but very little air coming through any of the vents. 5. Dryer not working — not getting hot so it won’t dry clothes.',
		tags: ['handyperson', 'punch-list', 'move-in', 'multi-issue-single-vendor', 'vendor-dispatch']
	},
	{
		wo: '1347-1',
		vendor: 'Reckon & Reckon Plumbing Inc.',
		property: '2135 Ivar Ave',
		status: 'Completed',
		title: 'Kitchen sink backup at 2135 Ivar Ave → Reckon & Reckon Plumbing',
		summary:
			'Reckon & Reckon Plumbing cleared kitchen sink backing up when sinks run at 2135 Ivar Ave unit 1.',
		raw_text: 'Kitchen sink is backing up when we run bathroom or kitchen sinks',
		tags: ['plumbing', 'drain', 'sink', 'status-resolved']
	},
	{
		wo: '1348-1',
		vendor: 'George HVAC',
		property: '1616 Ashland Ave',
		status: 'Scheduled',
		title: 'AC + disposals at 1616 Ashland Ave → George HVAC',
		summary:
			'George HVAC handled weak-airflow AC cycling on/off + two dead kitchen disposals at 1616 Ashland Ave.',
		raw_text:
			'AC not working - fan in the outdoor condenser spins but barely any air coming through the indoor vents. Unit turns on and off repeatedly. Replaced dirty filter and batteries in thermostat, but still not working. Garbage disposals not working - both kitchen sink disposals do not work. Unable to turn them manually with allen key. Hit red reset button, but they just hum repeatedly for 20 seconds before shutting off. Tried unplugging and replugging, still not working.',
		tags: ['hvac', 'ac', 'disposal', 'multi-issue-single-vendor', 'vendor-dispatch']
	},
	{
		wo: '1349-1',
		vendor: 'A1 Service Appliances, Inc.',
		property: '829 Bunker Hill',
		status: 'Completed',
		title: 'AC not cooling at 829 Bunker Hill → A1 Service Appliances',
		summary: 'A1 Service Appliances handled AC not cooling at 829 Bunker Hill unit 6.',
		raw_text: 'AC is not cooling',
		tags: ['hvac', 'ac', 'appliance', 'status-resolved']
	},
	{
		wo: '1352-1',
		vendor: "Garcia's Handyman and Cleaning Services LLC.",
		property: '2312 West Blvd',
		status: 'Completed',
		title: 'Smoke detector at 2312 West Blvd → Garcia’s Handyman',
		summary: 'Garcia’s Handyman checked smoke detector at 2312 West Blvd.',
		raw_text: 'Check smoke detector',
		tags: ['handyperson', 'smoke-detector', 'fire-safety', 'status-resolved']
	},
	{
		wo: '1354-1',
		vendor: 'Rightway Apartment Service',
		property: '8921 Wonderland Park Ave',
		status: 'Completed',
		title: 'Garbage disposal at 8921 Wonderland → Rightway',
		summary: 'Rightway Apartment Service checked garbage disposal at 8921 Wonderland Park Ave.',
		raw_text: 'check garbage disposal',
		tags: ['handyperson', 'disposal', 'plumbing', 'status-resolved']
	},
	{
		wo: '1355-1',
		vendor: 'Rightway Apartment Service',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'Washer flooding at 9th St Bungalow → Rightway',
		summary: 'Rightway Apartment Service handled washer flooding onto floor at 9th St Bungalow Home LLC unit 12.',
		raw_text: 'Washer water flooding onto floor',
		tags: ['handyperson', 'washer', 'leak', 'laundry', 'status-resolved']
	},
	{
		wo: '1356-1',
		vendor: 'A1 Service Appliances, Inc.',
		property: '829 Bunker Hill',
		status: 'Completed',
		title: 'AC not cooling at 829 Bunker Hill → A1 Service Appliances',
		summary: 'A1 Service Appliances handled AC not cooling at 829 Bunker Hill unit 5.',
		raw_text: 'AC not cooling',
		tags: ['hvac', 'ac', 'appliance', 'status-resolved']
	},
	{
		wo: '1355-2',
		vendor: 'Reckon & Reckon Plumbing Inc.',
		property: '9th St Bungalow Home LLC',
		status: 'Work Done',
		title: 'Snake plumbing line at 9th St Bungalow → Reckon & Reckon Plumbing',
		summary: 'Reckon & Reckon Plumbing snaked plumbing line at 9th St Bungalow Home LLC unit 12.',
		raw_text: 'need to snake plumbing line.',
		tags: ['plumbing', 'drain', 'snake', 'status-resolved']
	},
	{
		wo: '1349-2',
		vendor: 'Make It Work AC Service Inc.',
		property: '829 Bunker Hill',
		status: 'Completed',
		title: 'AC not cooling at 829 Bunker Hill → Make It Work AC Service',
		summary: 'Make It Work AC Service handled AC not cooling at 829 Bunker Hill unit 6.',
		raw_text: 'AC not cooling',
		tags: ['hvac', 'ac', 'status-resolved']
	},
	{
		wo: '1348-2',
		vendor: 'A1 Service Appliances, Inc.',
		property: '1616 Ashland Ave',
		status: 'Completed',
		title: 'AC weak airflow at 1616 Ashland Ave → A1 Service Appliances',
		summary:
			'A1 Service Appliances handled weak-airflow AC cycling on/off at 1616 Ashland Ave.',
		raw_text:
			'AC not working - fan in the outdoor condenser spins but barely any air coming through the indoor vents. Unit turns on and off repeatedly. Replaced dirty filter and batteries in thermostat, but still not working.',
		tags: ['hvac', 'ac', 'appliance', 'status-resolved']
	},
	{
		wo: '1357-2',
		vendor: 'A1 Service Appliances, Inc.',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'Fridge not cooling at 9th St Bungalow → A1 Service Appliances',
		summary:
			'A1 Service Appliances handled fridge/freezer not cooling after defrost at 9th St Bungalow Home LLC unit 12.',
		raw_text:
			'Fridge/freezer not cooling. Our technician took a look and could not find anything wrong, he had the tenant defrost the freezer overnight and it is still not cooling. Please arrange time with the tenant her number is 310-707-8608',
		tags: ['appliance', 'fridge', 'status-resolved']
	},
	{
		wo: '1360-1',
		vendor: 'A1 Service Appliances, Inc.',
		property: '5178 Almont St',
		status: 'Completed',
		title: 'AC not cooling at 5178 Almont St → A1 Service Appliances',
		summary:
			'A1 Service Appliances serviced rooftop AC not blowing cold after filter change at 5178 Almont St.',
		raw_text:
			'The AC doesn’t seem to blow cold, the main filter inside was extremely dirty so I changed that but it’s not really making a difference so I think the system on the roof might need a service. Thanks!',
		tags: ['hvac', 'ac', 'appliance', 'status-resolved']
	},
	{
		wo: '1341-2',
		vendor: 'All City Plumbing Inc',
		property: '9033 Dicks St',
		status: 'Scheduled',
		title: 'Sewer smell at 9033 Dicks St → All City Plumbing',
		summary:
			'All City Plumbing investigated recurring sewer smell in entryway at 9033 Dicks St.',
		raw_text:
			'Tenant reported a sewer smell in entryway. Please see what is causing this and if further investigation needed to be done.',
		tags: ['plumbing', 'sewage', 'odor', 'vendor-dispatch']
	},
	{
		wo: '1351-2',
		vendor: 'A1 Service Appliances, Inc.',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'Loud AC at 9th St Bungalow → A1 Service Appliances',
		summary:
			'A1 Service Appliances handled AC making loud fan noise + not turning off at 9th St Bungalow Home LLC unit 1.',
		raw_text: 'The AC is making a loud fan noise and won’t turn off',
		tags: ['hvac', 'ac', 'appliance', 'status-resolved']
	},
	{
		wo: '1335-2',
		vendor: 'A1 Service Appliances, Inc.',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'AC won’t turn on at 9th St Bungalow → A1 Service Appliances',
		summary:
			'A1 Service Appliances fixed AC that would not power on at 9th St Bungalow Home LLC unit 9.',
		raw_text:
			'Ac is not turning on. I tried replacing batteries in remote. I tried turning on manually with button on unit would not turn on. I tried resetting the breaker. I tried turning it back on with both remote and button and would not turn on',
		tags: ['hvac', 'ac', 'appliance', 'status-resolved']
	},
	{
		wo: '1370-1',
		vendor: 'Jose Rivera Landscaping',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Landscaping at 742 N Cherokee → Jose Rivera Landscaping',
		summary: 'Jose Rivera Landscaping handled monthly gardening at 742 N Cherokee.',
		raw_text: 'Gardening - Monthly',
		tags: ['landscaping', 'gardening', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1359-3',
		vendor: 'United Glass & Windows',
		property: '4418 Vantage Ave',
		status: 'Completed',
		title: 'Broken window at 4418 Vantage Ave → United Glass & Windows',
		summary: 'United Glass & Windows repaired broken window at 4418 Vantage Ave unit 1.',
		raw_text: 'Repair broken window',
		tags: ['windows', 'glass', 'window', 'status-resolved']
	},
	{
		wo: '1371-1',
		vendor: 'A1 Service Appliances, Inc.',
		property: '4418 Vantage Ave',
		status: 'Scheduled',
		title: 'Leaking AC at 4418 Vantage Ave → A1 Service Appliances',
		summary:
			'A1 Service Appliances handled leaking bedroom AC causing moisture in vacant unit at 4418 Vantage Ave.',
		raw_text:
			'AC in bedroom is leaking and causing moisture issue, property is vacant. Please call 805-504-6160 to schedule and get lockbox information.',
		tags: ['hvac', 'ac', 'leak', 'appliance', 'vendor-dispatch']
	},
	{
		wo: '1224-2',
		vendor: 'A1 Service Appliances, Inc.',
		property: '829 Bunker Hill',
		status: 'Waiting',
		title: 'Heater + replacement estimate at 829 Bunker Hill → A1 Service Appliances',
		summary:
			'A1 Service Appliances handled non-working heater + replacement-system estimate at 829 Bunker Hill unit 5.',
		raw_text:
			'The heater is not working, can you also give an estimate to replace the system as it is pretty old. Please schedule with the tenant.',
		tags: ['hvac', 'heater', 'estimate', 'appliance', 'vendor-dispatch']
	},
	{
		wo: '1375-1',
		vendor: 'Rightway Apartment Service',
		property: '4418 Vantage Ave',
		status: 'Completed',
		title: 'Pipe leak at 4418 Vantage Ave → Rightway',
		summary:
			'Rightway Apartment Service assessed pipe leak on building side by unit 5 at 4418 Vantage Ave.',
		raw_text: 'There is a leak coming from a pipe on the side of the building by unit 5. Please asses.',
		tags: ['handyperson', 'leak', 'plumbing', 'status-resolved']
	},
	{
		wo: '1320-2',
		vendor: 'Primate Pest Elimination',
		property: '2419 S Cochran Ave',
		status: 'Waiting',
		title: 'Secondary spraying at 2419 S Cochran → Primate Pest Elimination',
		summary:
			'Primate Pest Elimination handled secondary bug spraying follow-up at 2419 S Cochran Ave.',
		raw_text: 'Primate checking for bugs-secondary spraying',
		tags: ['pest-control', 'bugs', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1379-1',
		vendor: 'Raptor Appliance Repair',
		property: '9th St Bungalow Home LLC',
		status: 'Work Done',
		title: 'Freezer leak at 9th St Bungalow → Raptor Appliance Repair',
		summary:
			'Raptor Appliance Repair handled freezer leaking into fridge, clogged defrost drain, at 9th St Bungalow Home LLC unit 13.',
		raw_text:
			'Water is leaking from my freezer into my fridge. Likely due to a clogged defrost drain. The entire bottom tray is completely full of water.',
		tags: ['appliance', 'fridge', 'leak', 'status-resolved']
	},
	{
		wo: '1380-2',
		vendor: 'Tony Germann',
		property: '2419 S Cochran Ave',
		status: 'Assigned',
		title: 'Intermittent heater at 2419 S Cochran → Tony Germann',
		summary:
			'Tony Germann handled intermittently-working heater needing service + estimate at 2419 S Cochran Ave unit 2419.',
		raw_text:
			'The heater works intermittently- we believe it needs to be serviced. Please send us an estimate.',
		tags: ['hvac', 'heater', 'estimate', 'vendor-dispatch']
	},
	{
		wo: '1383-1',
		vendor: 'Raptor Appliance Repair',
		property: '5179 Huntington Dr.',
		status: 'Completed',
		title: 'Washer leaking at 5179 Huntington Dr. → Raptor Appliance Repair',
		summary: 'Raptor Appliance Repair fixed washer leaking through door at 5179 Huntington Dr.',
		raw_text: 'The washer is leaking through the door',
		tags: ['appliance', 'washer', 'leak', 'laundry', 'status-resolved']
	},
	{
		wo: '1390-1',
		vendor: 'ASAP Locksmith',
		property: '9th St Bungalow Home LLC',
		status: 'Completed',
		title: 'Rekey door knobs at 9th St Bungalow → ASAP Locksmith',
		summary:
			'ASAP Locksmith rekeyed front + back door knobs at 9th St Bungalow Home LLC unit 8.',
		raw_text: 'Please rekey the front and back door knob of the unit.',
		tags: ['locks', 'rekey', 'lock', 'status-resolved']
	},
	{
		wo: '1394-1',
		vendor: 'All City Plumbing Inc',
		property: '829 Bunker Hill',
		status: 'Work Done',
		title: 'No hot water at 829 Bunker Hill → All City Plumbing',
		summary: 'All City Plumbing handled no hot water at 829 Bunker Hill unit 6.',
		raw_text: 'Tenant reported no hot water',
		tags: ['plumbing', 'water-heater', 'hot-water', 'status-resolved']
	},
	{
		wo: '1397-1',
		vendor: 'King Neptune Pools Inc.',
		property: '8921 Wonderland Park Ave',
		status: 'Assigned',
		title: 'Pool light out at 8921 Wonderland → King Neptune Pools',
		summary: 'King Neptune Pools handled out pool light at 8921 Wonderland Park Ave.',
		raw_text: 'Tenant reported a light inside the pool is out',
		tags: ['pool', 'lighting', 'vendor-dispatch']
	},
	{
		wo: '1398-1',
		vendor: 'All City Plumbing Inc',
		property: '3473 Sabina St.',
		status: 'Scheduled',
		title: 'Ceiling bubbling at 3473 Sabina St. → All City Plumbing',
		summary:
			'All City Plumbing investigated bathroom ceiling bubbling under upstairs bathroom at 3473 Sabina St.',
		raw_text:
			'There is bubbling on the ceiling in the bathroom, directly above that bathroom is the other units bathroom. Please call us with your findings.',
		tags: ['plumbing', 'leak', 'ceiling', 'vendor-dispatch']
	},
	{
		wo: '1404-1',
		vendor: 'South County Exterminators',
		property: '4219 Abner St',
		status: 'Work Done',
		title: 'Carpenter ants at 4219 Abner St → South County Exterminators',
		summary:
			'South County Exterminators handled flying carpenter ant infestation in back bedroom at 4219 Abner St.',
		raw_text: 'Ant infestation - flying carpenter ants - in back bedroom',
		tags: ['pest-control', 'ants', 'status-resolved']
	},
	{
		wo: '1406-1',
		vendor: 'Jimmy’s Pool Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Pool service at 742 N Cherokee → Jimmy’s Pool Service',
		summary: 'Jimmy’s Pool Service handled monthly pool cleaning at 742 N Cherokee.',
		raw_text: 'Monthly pool cleaning',
		tags: ['pool', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1407-1',
		vendor: 'Jose Rivera Landscaping',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Landscaping at 742 N Cherokee → Jose Rivera Landscaping',
		summary: 'Jose Rivera Landscaping handled monthly gardening at 742 N Cherokee.',
		raw_text: 'Gardening - Monthly',
		tags: ['landscaping', 'gardening', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1438-1',
		vendor: 'All City Plumbing Inc',
		property: '4418 Vantage Ave',
		status: 'Scheduled',
		title: 'No hot shower water at 4418 Vantage Ave → All City Plumbing',
		summary: 'All City Plumbing handled shower water not getting hot at 4418 Vantage Ave unit 3.',
		raw_text: 'shower water does not get hot',
		tags: ['plumbing', 'hot-water', 'shower', 'vendor-dispatch']
	},
	{
		wo: '1366-4',
		vendor: 'Bresnahan Rain Gutter Cleaning',
		property: '829 Bunker Hill',
		status: 'Scheduled',
		title: 'Fallen gutter estimate at 829 Bunker Hill → Bresnahan Rain Gutter',
		summary:
			'Bresnahan Rain Gutter Cleaning estimated reseating gutter fallen into balcony at 829 Bunker Hill unit 9.',
		raw_text: 'Please give us estimates for: 1.Gutter fell into balcony see if it can be put back into place',
		tags: ['roofing', 'gutter', 'estimate', 'vendor-dispatch']
	},
	{
		wo: '1447-1',
		vendor: 'Bondy Service Inc',
		property: '9th St Bungalow Home LLC',
		status: 'Assigned',
		title: 'Communal laundry down at 9th St Bungalow → Bondy Service',
		summary:
			'Bondy Service handled communal washer/dryer not powering on, app error, at 9th St Bungalow Home LLC unit 9.',
		raw_text:
			'Hello, The communal washer and dryer are not working. There’s no numbers displayed and the do not turn on with the app, an error message is received.',
		tags: ['laundry', 'washer', 'dryer', 'vendor-dispatch']
	},
	{
		wo: '1459-1',
		vendor: 'All City Plumbing Inc',
		property: '2123 Linnington',
		status: 'Work Done',
		title: 'Shower wall leak at 2123 Linnington → All City Plumbing',
		summary:
			'All City Plumbing handled leak in wall behind upstairs shower dripping to floor below at 2123 Linnington.',
		raw_text:
			'There is a leak in the wall behind the upstairs shower that dripped though the floor downstairs',
		tags: ['plumbing', 'leak', 'shower', 'status-resolved']
	},
	{
		wo: '1467-1',
		vendor: 'Rightway Apartment Service',
		property: '2135 Ivar Ave',
		status: 'Assigned',
		title: 'Garage sprinkler leak at 2135 Ivar Ave → Rightway',
		summary:
			'Rightway Apartment Service handled leak from garage water pipe/sprinkler at 2135 Ivar Ave unit 7.',
		raw_text: 'There is a leak from a water pipe/sprinkler in the garage',
		tags: ['handyperson', 'leak', 'plumbing', 'vendor-dispatch']
	},
	{
		wo: '1468-1',
		vendor: 'Rightway Apartment Service',
		property: 'Horizon Ave Duplex',
		status: 'Completed',
		title: 'Washer + dryer at Horizon Ave Duplex → Rightway',
		summary:
			'Rightway Apartment Service handled stuck dryer door + washer not completing cycles at Horizon Ave Duplex unit 218.',
		raw_text:
			'Dryer door is stuck and the washing machine is not fully completing cycles intermitently.',
		tags: ['handyperson', 'washer', 'dryer', 'laundry', 'status-resolved']
	},
	{
		wo: '1469-1',
		vendor: 'Rightway Apartment Service',
		property: '2135 Ivar Ave',
		status: 'Assigned',
		title: 'Garage ceiling leak at 2135 Ivar Ave → Rightway',
		summary:
			'Rightway Apartment Service handled parking-garage leak dripping on car + pooling ceiling at 2135 Ivar Ave unit 2.',
		raw_text:
			'There is a leak in the parking garage that is dripping onto my car. Also there is a wet circle on the ceiling is beginning to pool from the source.',
		tags: ['handyperson', 'leak', 'ceiling', 'vendor-dispatch']
	},
	{
		wo: '1360-2',
		vendor: 'A1 Service Appliances, Inc.',
		property: '5178 Almont St',
		status: 'Scheduled',
		title: 'AC recurring + thermostat at 5178 Almont St → A1 Service Appliances',
		summary:
			'A1 Service Appliances handled recurring AC issue with flashing thermostat at 5178 Almont St.',
		raw_text: 'Tenant reporting same issue and thermostat flashing',
		tags: ['hvac', 'ac', 'thermostat', 'appliance', 'vendor-dispatch']
	},
	{
		wo: '1471-1',
		vendor: 'Rightway Apartment Service',
		property: '2135 Ivar Ave',
		status: 'Assigned',
		title: 'Hallway door latch at 2135 Ivar Ave → Rightway',
		summary:
			'Rightway Apartment Service handled recurring broken latch on front glass hallway door at 2135 Ivar Ave unit 1.',
		raw_text: 'Front glass door to main hallway: latch is broken again',
		tags: ['handyperson', 'door', 'latch', 'vendor-dispatch']
	},
	{
		wo: '1472-1',
		vendor: 'Raptor Appliance Repair',
		property: '8342 Kirkwood',
		status: 'Work Done',
		title: 'Washer not working at 8342 Kirkwood → Raptor Appliance Repair',
		summary: 'Raptor Appliance Repair handled non-working washing machine at 8342 Kirkwood.',
		raw_text: 'Washer machine not working.',
		tags: ['appliance', 'washer', 'laundry', 'status-resolved']
	},
	{
		wo: '1475-1',
		vendor: 'All City Plumbing Inc',
		property: '1827 S Barrington Ave #107',
		status: 'Work Done',
		title: 'Slow bathroom sink at 1827 S Barrington → All City Plumbing',
		summary: 'All City Plumbing cleared slow-draining bathroom sink at 1827 S Barrington Ave #107.',
		raw_text: 'Bathroom sink draining slow',
		tags: ['plumbing', 'drain', 'sink', 'status-resolved']
	},
	{
		wo: '1478-1',
		vendor: 'Raptor Appliance Repair',
		property: '8342 Kirkwood',
		status: 'Work Done',
		title: 'Garbage disposal at 8342 Kirkwood → Raptor Appliance Repair',
		summary: 'Raptor Appliance Repair handled non-working garbage disposal at 8342 Kirkwood.',
		raw_text: 'Garbage disposal not working.',
		tags: ['appliance', 'disposal', 'status-resolved']
	},
	{
		wo: '1481-1',
		vendor: 'Raptor Appliance Repair',
		property: '9th St Bungalow Home LLC',
		status: 'Work Done',
		title: 'Disposal switch at 9th St Bungalow → Raptor Appliance Repair',
		summary:
			'Raptor Appliance Repair handled garbage disposal not activating from light switch at 9th St Bungalow Home LLC unit 12.',
		raw_text: 'Garbage Disposal, Light switch not activating disposal',
		tags: ['appliance', 'disposal', 'electrical', 'status-resolved']
	},
	{
		wo: '1485-1',
		vendor: 'George HVAC',
		property: 'Horizon Ave Duplex',
		status: 'Assigned',
		title: 'Dehumidifier service at Horizon Ave Duplex → George HVAC',
		summary: 'George HVAC serviced + cleaned dehumidifier at Horizon Ave Duplex.',
		raw_text: 'Please service and clean the dehumidifier',
		tags: ['hvac', 'dehumidifier', 'vendor-dispatch']
	},
	{
		wo: '1489-1',
		vendor: 'Jimmy’s Pool Service',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Pool service at 742 N Cherokee → Jimmy’s Pool Service',
		summary: 'Jimmy’s Pool Service handled monthly pool cleaning at 742 N Cherokee.',
		raw_text: 'Monthly pool cleaning',
		tags: ['pool', 'recurring-treatment', 'vendor-dispatch']
	},
	{
		wo: '1490-1',
		vendor: 'Jose Rivera Landscaping',
		property: '742 N Cherokee',
		status: 'Assigned',
		title: 'Landscaping at 742 N Cherokee → Jose Rivera Landscaping',
		summary: 'Jose Rivera Landscaping handled monthly gardening at 742 N Cherokee.',
		raw_text: 'Gardening - Monthly',
		tags: ['landscaping', 'gardening', 'recurring-treatment', 'vendor-dispatch']
	}
];

console.log(`seeding ${OBS.length} Green Oak dispatch observations (batch 2) into workspace ${WORKSPACE}…`);

let written = 0;
const results = [];
for (const o of OBS) {
	const tags =
		o.status === 'Completed' && !o.tags.includes('status-resolved')
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
	path.join(AGENT_ROOT, 'data', 'seed-greenoak-dispatch-batch2-results.json'),
	JSON.stringify({ processed: OBS.length, written, results }, null, 2)
);
console.log('results → agent/data/seed-greenoak-dispatch-batch2-results.json');
