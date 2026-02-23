<script lang="ts">
	import DispatchVendorsDemo from '$lib/components/DispatchVendorsDemo.svelte';
	import ProcessInvoicesDemo from '$lib/components/ProcessInvoicesDemo.svelte';
	import TriageIssuesDemo from '$lib/components/TriageIssuesDemo.svelte';
	import skyline from '$lib/assets/skyline.png';

	type DemoItem = {
		id: string;
		title: string;
		subtitle: string;
		time?: string;
		changes?: string;
		done?: boolean;
	};

	const demoSections: { label: string; items: DemoItem[] }[] = [
		{
			label: 'In progress',
			items: [
				{
					id: 'boiler-leak',
					title: 'Boiler leak in 401',
					subtitle: 'Generating suggestion'
				}
			]
		},
		{
			label: 'Ready for review',
			items: [
				{
					id: 'elevator-noise',
					title: 'Elevator noise complaint',
					subtitle: 'Vendor recommendation ready.',
					time: 'now',
					done: true
				},
				{
					id: 'invoice-email',
					title: 'Plumbing invoice via email',
					subtitle: 'Payable draft ready.',
					time: '12m',
					done: true
				}
			]
		}
	];

	const demoDetails: Record<
		string,
		{
			title: string;
			summaryTitle: string;
			summaryBody: string;
			thought: string;
			search: string;
			reply: string;
		}
	> = {
		'boiler-leak': {
			title: 'Boiler leak in unit 401',
			summaryTitle: 'Draft repair plan',
			summaryBody:
				'Confirm shutoff access, schedule the on-call plumber, and notify residents about the 2-hour water interruption window.',
			thought: 'Thought 9s',
			search: 'Checked boiler maintenance logs and last vendor visit notes.',
			reply: 'Queued the emergency dispatch and pre-filled the resident notice.'
		},
		'elevator-noise': {
			title: 'Elevator noise complaint',
			summaryTitle: 'Recommend next step',
			summaryBody:
				'Escalate to the elevator vendor, request a vibration check, and log a safety inspection follow-up.',
			thought: 'Thought 5s',
			search: 'Reviewed prior elevator tickets and vendor SLA coverage.',
			reply: 'Prepared vendor outreach with a proposed inspection window.'
		},
		'invoice-email': {
			title: 'Plumbing invoice via email',
			summaryTitle: 'Invoice intake summary',
			summaryBody:
				'Captured the emailed invoice for the 3/12 emergency drain clearing. Needs coding to Repairs:Plumbing before approval.',
			thought: 'Thought 4s',
			search: 'Matched the invoice to work order #1842 and vendor W-9 records.',
			reply: 'Ready for approval once coded to the correct GL.'
		}
	};

	let activeDemoId = 'invoice-email';
</script>

<div class="min-h-screen overflow-x-hidden bg-white text-stone-800">
	<header class="fixed inset-x-0 top-0 z-30 border-b border-stone-200 bg-white/90 backdrop-blur">
		<div
			class="mx-auto flex w-full max-w-7xl flex-col items-start justify-between gap-6 px-6 py-4 md:flex-row md:items-center"
		>
			<a
				href="/"
				class="text-md font-regular flex items-center gap-1 tracking-[0.1em] uppercase"
				style="font-family: 'Zalando Sans Expanded', sans-serif;"
			>
				Bedrock
			</a>
			<nav class="flex flex-wrap items-center gap-6 text-sm text-neutral-600">
				<a class="hover:text-neutral-900" href="#features">Features</a>
				<a class="hover:text-neutral-900" href="#integrations">Integrations</a>
			</nav>
			<div class="flex items-center gap-3">
				<a
					class="rounded-xl bg-stone-800 px-4 py-2 text-xs text-neutral-200 transition-colors hover:bg-stone-700"
					href="https://calendly.com/21andrewch/30min"
					target="_blank"
					rel="noreferrer"
				>
					Book a demo
				</a>
			</div>
		</div>
	</header>
	<div class="mx-auto flex w-full max-w-7xl flex-col gap-20 px-6 pt-24 pb-20">
		<section class="flex flex-col gap-16">
			<div class="mt-20 max-w-4xl">
				<h1 class="text-6xl font-medium text-neutral-800">
					Make property management<br />feel truly <span class="italic">effortless</span>.
				</h1>
				<p class="mt-5 text-lg text-neutral-600">
					<span class="text-neutral-600">Bedrock</span> manages the full maintenance workflow, from
					tenant messages to<br /><span class="text-lg"
						>approval-ready invoices, helping you grow faster without giving up control.</span
					>
				</p>
				<div class="mt-7 flex items-center gap-3">
					<a
						href="/signup"
						class="inline-flex flex-row items-center gap-1 rounded-xl bg-stone-800 px-4.5 py-2 text-[15px] text-neutral-200 transition-colors hover:bg-stone-700"
					>
						Book a demo
					</a>
					<a
						href="https://calendly.com/21andrewch/30min"
						target="_blank"
						rel="noreferrer"
						class="inline-flex flex-row items-center gap-1 rounded-xl border border-stone-300 bg-white px-4.5 py-2 text-[15px] text-stone-800 transition-colors hover:bg-stone-100"
					>
						Get started
					</a>
				</div>
			</div>
			<div class="relative overflow-hidden rounded-sm bg-[#1e1e1e] p-6">
				<svg
					class="pointer-events-none absolute inset-0 h-full w-full"
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 1200 700"
					preserveAspectRatio="none"
				>
					<defs>
						<linearGradient id="demo-bg" x1="0" y1="0" x2="1" y2="1">
							<stop offset="0%" stop-color="#1e1e1e" />
							<stop offset="55%" stop-color="#232323" />
							<stop offset="100%" stop-color="#191919" />
						</linearGradient>
						<filter id="warp" x="-20%" y="-20%" width="140%" height="140%">
							<feTurbulence
								type="fractalNoise"
								baseFrequency="0.008 0.025"
								numOctaves="3"
								seed="8"
								result="n"
							/>
							<feDisplacementMap
								in="SourceGraphic"
								in2="n"
								scale="50"
								xChannelSelector="R"
								yChannelSelector="G"
							/>
						</filter>
						<filter id="strata" x="-20%" y="-20%" width="140%" height="140%">
							<feTurbulence
								type="fractalNoise"
								baseFrequency="0.003 0.04"
								numOctaves="4"
								seed="12"
								result="t"
							/>
							<feComponentTransfer in="t" result="bands">
								<feFuncR type="table" tableValues="0 0.1 0.15 0.5 0.55 0.6 0.85 0.9 1" />
								<feFuncG type="table" tableValues="0 0.1 0.15 0.5 0.55 0.6 0.85 0.9 1" />
								<feFuncB type="table" tableValues="0 0.1 0.15 0.5 0.55 0.6 0.85 0.9 1" />
							</feComponentTransfer>
							<feColorMatrix
								in="bands"
								type="matrix"
								result="a"
								values="
									0 0 0 0 0
									0 0 0 0 0
									0 0 0 0 0
									1 0 0 0 0"
							/>
							<feGaussianBlur in="a" stdDeviation="0.65" result="soft" />
						</filter>
						<filter id="strata-sharp" x="-20%" y="-20%" width="140%" height="140%">
							<feTurbulence
								type="fractalNoise"
								baseFrequency="0.0005 0.065"
								numOctaves="2"
								seed="7"
								result="t"
							/>
							<feComponentTransfer in="t" result="bands">
								<feFuncR type="discrete" tableValues="0 0.2 0.4 0.8 1" />
								<feFuncG type="discrete" tableValues="0 0.2 0.4 0.8 1" />
								<feFuncB type="discrete" tableValues="0 0.2 0.4 0.6 0.8 1" />
							</feComponentTransfer>
							<feColorMatrix
								in="bands"
								type="matrix"
								result="a"
								values="
									0 0 0 0 0
									0 0 0 0 0
									0 0 0 0 0
									1.2 0 0 0 0"
							/>
							<feGaussianBlur in="a" stdDeviation="0.45" result="soft" />
						</filter>
						<filter id="grain" x="0%" y="0%" width="100%" height="100%">
							<feTurbulence
								type="fractalNoise"
								baseFrequency="0.7"
								numOctaves="4"
								seed="5"
								result="noise"
							/>
							<feColorMatrix
								in="noise"
								type="matrix"
								values="
									0 0 0 0 0
									0 0 0 0 0
									0 0 0 0 0
									0.5 0 0 0 0"
							/>
						</filter>
						<radialGradient id="demo-vignette" cx="50%" cy="30%" r="80%">
							<stop offset="0%" stop-color="#ffffff" stop-opacity="0.12" />
							<stop offset="60%" stop-color="#ffffff" stop-opacity="0.05" />
							<stop offset="100%" stop-color="#000000" stop-opacity="0.25" />
						</radialGradient>
					</defs>
					<rect width="1200" height="700" fill="url(#demo-bg)" />
					<g opacity="0.45" filter="url(#warp)">
						<rect width="1200" height="700" fill="#ffffff" filter="url(#strata)" />
					</g>
					<g opacity="0.5" filter="url(#warp)">
						<rect width="1200" height="700" fill="#ffffff" filter="url(#strata-sharp)" />
					</g>
					<rect width="1200" height="700" fill="#ffffff" filter="url(#grain)" opacity="0.95" />
					<rect width="1200" height="700" fill="url(#demo-vignette)" />
				</svg>
				<div
					class="pointer-events-none absolute -inset-24 opacity-90 blur-3xl"
					style="background-image: radial-gradient(900px 520px at 25% 25%, rgba(85, 85, 85, 0.95), transparent 62%), radial-gradient(760px 520px at 80% 30%, rgba(65, 65, 65, 0.85), transparent 60%), radial-gradient(760px 520px at 55% 92%, rgba(45, 45, 45, 0.9), transparent 62%);"
				></div>
				<div class="relative z-10 rounded-2xl">
					<div
						class="flex aspect-[16/10] min-h-[240px] w-full items-center justify-center p-4 sm:p-6"
					>
						<div
							class="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-neutral-300 bg-stone-50 shadow-lg"
						>
							<div
								class="flex items-center justify-between border-b border-neutral-200 bg-stone-100 px-4 py-2 text-xs text-neutral-500"
							>
								<div class="flex items-center gap-1.5">
									<span class="h-2.5 w-2.5 rounded-full bg-stone-300"></span>
									<span class="h-2.5 w-2.5 rounded-full bg-stone-200"></span>
									<span class="h-2.5 w-2.5 rounded-full bg-stone-100"></span>
								</div>
								<div class="text-[12px] font-light">Bedrock</div>
								<div class="text-[11px] text-neutral-400"></div>
							</div>
							<div class="grid h-full grid-cols-[0.9fr_1.6fr]">
								<div
									class="border-r border-neutral-200 bg-stone-50 px-3 py-4 text-xs text-neutral-500 sm:px-4"
								>
									{#each demoSections as section}
										<div class="mb-4 last:mb-0">
											<div class="mb-2 text-[11px] text-neutral-400 uppercase">
												{section.label}
											</div>
											<div class="flex flex-col gap-1">
												{#each section.items as item}
													<button
														class={`flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left text-sm transition ${
															activeDemoId === item.id
																? 'bg-stone-100 text-neutral-900'
																: 'text-neutral-600 hover:bg-stone-100 hover:text-neutral-800'
														}`}
														on:click={() => (activeDemoId = item.id)}
													>
														{#if item.done}
															<svg
																class={`mt-0.5 h-4 w-4 ${
																	activeDemoId === item.id ? 'text-neutral-900' : 'text-neutral-400'
																}`}
																fill="none"
																stroke="currentColor"
																stroke-width="0.8"
																stroke-linecap="round"
																stroke-linejoin="round"
																viewBox="0 0 16 16"
																xmlns="http://www.w3.org/2000/svg"
															>
																<circle cx="8" cy="8" r="6.2" />
																<path d="M5.2 8.2 7 10.1l3.8-4" />
															</svg>
														{:else}
															<span
																class={`mt-0.5 h-3.5 w-3.5 rounded-full border ${
																	activeDemoId === item.id
																		? 'border-neutral-700 bg-transparent'
																		: 'border-neutral-400 bg-transparent'
																}`}
															></span>
														{/if}
														<span class="flex-1">
															<span class="block truncate font-medium">{item.title}</span>
															<span class="block text-[11px] text-neutral-400">
																{item.subtitle}
															</span>
														</span>
														{#if item.time}
															<span class="text-[11px] text-neutral-400">{item.time}</span>
														{/if}
													</button>
												{/each}
											</div>
										</div>
									{/each}
								</div>
								<div
									class="flex flex-col gap-4 bg-stone-50 px-4 py-4 text-sm text-neutral-700 sm:px-6"
								>
									<div class="text-base font-semibold text-neutral-800">
										{demoDetails[activeDemoId].title}
									</div>
									<div
										class="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-700"
									>
										<div class="mb-2 text-sm font-semibold text-neutral-800">
											{demoDetails[activeDemoId].summaryTitle}
										</div>
										<p class="text-sm leading-relaxed text-neutral-600">
											{demoDetails[activeDemoId].summaryBody}
										</p>
									</div>
									<div class="text-xs text-neutral-400">
										{demoDetails[activeDemoId].thought}
									</div>
									<div class="text-sm text-neutral-500">
										{demoDetails[activeDemoId].search}
									</div>
									<div class="text-sm font-medium text-neutral-700">
										{demoDetails[activeDemoId].reply}
									</div>
									<div
										class="mt-auto rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-500"
									>
										Plan, search, build anything...
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>

		<section class="flex scroll-mt-28 flex-col gap-10" id="features">
			<div class="grid gap-4 md:grid-cols-3">
				<div class="flex min-h-[420px] flex-col rounded-sm bg-stone-50 p-4">
					<div class="text-sm text-neutral-900">Triage Issues</div>
					<p class="mt-2 text-sm leading-relaxed text-neutral-500">
						Turns tenant messages into a complete work order: priority, missing details, and a clear
						next step.
					</p>
					<div class="mt-6 flex-1 rounded-sm bg-stone-200">
						<TriageIssuesDemo />
					</div>
				</div>
				<div class="flex min-h-[420px] flex-col rounded-sm bg-stone-50 p-4">
					<div class="text-sm text-neutral-900">Dispatch Vendors</div>
					<p class="mt-2 text-sm leading-relaxed text-neutral-500">
						Recommends the right vendor, gets availability, schedules access, and keeps tenants
						updated.
					</p>
					<div class="mt-6 flex flex-1 items-center justify-center rounded-sm bg-stone-200 p-6">
						<div class="w-full">
							<DispatchVendorsDemo />
						</div>
					</div>
				</div>
				<div class="flex min-h-[420px] flex-col rounded-sm bg-stone-50 p-4">
					<div class="text-sm text-neutral-900">Process Invoices</div>
					<p class="mt-2 text-sm leading-relaxed text-neutral-500">
						Extracts invoice details, matches to the job, flags surprises, and awaits for approval
						and payment.
					</p>
					<div class="mt-6 flex flex-1 items-center justify-center rounded-sm bg-stone-200 p-6">
						<div class="w-full">
							<ProcessInvoicesDemo />
						</div>
					</div>
				</div>
			</div>
		</section>

		<section
			class="grid scroll-mt-28 gap-10 rounded-sm bg-stone-50 px-4 py-2 lg:grid-cols-[0.9fr_1.6fr]"
			id="integrations"
		>
			<div class="flex max-w-sm flex-col justify-center">
				<h2 class="text-xl">Integrates seamlessly</h2>
				<p class="mt-2 text-lg text-neutral-500">
					Draft actions inside your current workflow. You approve; we sync the results back.
				</p>
				<div class="mt-4 flex flex-wrap gap-2">
					<span
						class="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs text-neutral-700"
						>Gmail</span
					>
					<span
						class="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs text-neutral-700"
						>AppFolio</span
					>
				</div>
			</div>
			<div
				class="relative flex aspect-[16/10] min-h-[320px] items-center justify-center overflow-hidden rounded-sm border border-neutral-200 bg-neutral-100 lg:aspect-auto lg:h-[640px]"
			>
				<div
					class="absolute inset-0"
					style="background-image: radial-gradient(900px 520px at 30% 22%, rgba(116, 168, 179, 0.58), transparent 62%), radial-gradient(760px 520px at 80% 32%, rgba(212, 173, 146, 0.36), transparent 62%), radial-gradient(760px 520px at 55% 92%, rgba(163, 176, 118, 0.34), transparent 62%), linear-gradient(180deg, rgba(115, 164, 176, 0.2), rgba(241, 236, 228, 0.5));"
				></div>
				<div
					class="absolute inset-0 opacity-[0.07]"
					style="background-image: repeating-linear-gradient(135deg, rgba(0,0,0,0.22), rgba(0,0,0,0.22) 1px, transparent 1px, transparent 8px);"
				></div>
				<div
					class="absolute inset-0 bg-gradient-to-t from-stone-50/75 via-transparent to-transparent"
				></div>

				<div class="relative h-full w-full p-6 sm:p-8">
					<div
						class="absolute top-[20%] left-[12%] w-[74%] max-w-[720px] rounded-2xl border border-neutral-200 bg-white shadow-2xl"
					>
						<div
							class="flex items-center justify-between rounded-t-2xl border-b border-neutral-200 bg-stone-100 px-4 py-2 text-xs text-neutral-500"
						>
							<div class="flex items-center gap-1.5">
								<span class="h-2.5 w-2.5 rounded-full bg-stone-300"></span>
								<span class="h-2.5 w-2.5 rounded-full bg-stone-200"></span>
								<span class="h-2.5 w-2.5 rounded-full bg-stone-100"></span>
							</div>
							<div class="text-[12px] font-light">Gmail</div>
							<div class="text-[11px] text-neutral-400">Connected</div>
						</div>
						<div class="px-5 py-4">
							<div class="text-sm font-semibold text-neutral-900">New maintenance request</div>
							<div class="mt-2 space-y-2 text-sm text-neutral-700">
								<div class="rounded-lg bg-neutral-50 px-3 py-2">
									<span class="text-neutral-500">Tenant:</span>
									<span class="ml-2">"Water heater is making loud banging noises."</span>
								</div>
								<div class="rounded-lg bg-neutral-50 px-3 py-2">
									<span class="text-neutral-500">Bedrock draft:</span>
									<span class="ml-2">Ask for a video, mark urgent, recommend vendor.</span>
								</div>
							</div>
							<div class="mt-4 flex flex-wrap gap-2">
								<span class="rounded-md bg-stone-800 px-3 py-1.5 text-xs text-neutral-100"
									>Approve</span
								>
								<span
									class="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700"
									>Edit</span
								>
								<span
									class="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700"
									>Deny</span
								>
							</div>
						</div>
					</div>

					<div
						class="absolute top-[12%] right-[8%] hidden h-[84%] w-[38%] max-w-[320px] rounded-[38px] border border-neutral-200 bg-white shadow-2xl sm:block"
					>
						<div class="flex items-center justify-between px-6 pt-5 text-xs text-neutral-500">
							<div class="text-[12px] font-light">AppFolio</div>
							<div class="rounded-full bg-neutral-100 px-2 py-1 text-[11px]">Synced</div>
						</div>
						<div class="px-6 pt-4 pb-6">
							<div class="rounded-2xl border border-neutral-200 bg-white px-4 py-3">
								<div class="text-xs text-neutral-500">Work order</div>
								<div class="mt-1 text-sm font-semibold text-neutral-900">WO #1842</div>
								<div class="mt-3 space-y-2 text-xs text-neutral-600">
									<div class="flex items-center justify-between">
										<span>Status</span>
										<span class="font-medium text-neutral-800">Pending</span>
									</div>
									<div class="flex items-center justify-between">
										<span>Vendor</span>
										<span class="font-medium text-neutral-800">Ace Plumbing</span>
									</div>
									<div class="flex items-center justify-between">
										<span>Next</span>
										<span class="font-medium text-neutral-800">Schedule access</span>
									</div>
								</div>
							</div>
							<div class="mt-4 rounded-2xl border border-neutral-200 bg-white px-4 py-3">
								<div class="text-xs text-neutral-500">Invoice</div>
								<div class="mt-1 text-sm font-semibold text-neutral-900">Ready for review</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	</div>

	<footer id="request-demo" class="relative mt-12 overflow-hidden">
		<img
			src={skyline}
			alt=""
			class="pointer-events-none absolute inset-x-0 z-0 w-full opacity-60"
			style="mask-image: linear-gradient(to bottom, black 400px, transparent 480px); -webkit-mask-image: linear-gradient(to bottom, black 400px, transparent 480px);"
		/>
		<div
			class="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-8 bg-gradient-to-b from-transparent to-white"
		></div>
		<div
			class="relative z-10 mx-auto flex min-h-[450px] max-w-7xl flex-col items-center justify-center px-6 py-20 text-center"
		>
			<h2 class="text-6xl font-medium text-stone-800">Try Bedrock now.</h2>
			<a
				class="mt-6 rounded-xl bg-stone-800 px-6 py-2.5 text-sm text-neutral-100 transition-colors hover:bg-stone-700"
				href="https://calendly.com/21andrewch/30min"
				target="_blank"
				rel="noreferrer"
			>
				Contact us
			</a>
		</div>
		<div class="absolute inset-x-0 bottom-8 z-10 text-center text-sm text-stone-500">
			© {new Date().getFullYear()} Bedrock
		</div>
	</footer>
</div>
