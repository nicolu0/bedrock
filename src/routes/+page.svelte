<script lang="ts">
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


<div class="min-h-screen bg-[#F7F7F4] text-neutral-900">
	<header class="fixed inset-x-0 top-0 z-30 bg-[#f6f5f3]">
		<div
			class="mx-auto flex w-full max-w-7xl flex-col items-start justify-between gap-6 px-6 py-4 md:flex-row md:items-center"
		>
			<div class="flex items-center gap-2 text-md font-semibold tracking-[0.1em] uppercase" style="font-family: 'Zalando Sans Expanded', sans-serif;">
				 Bedrock
			</div>
			<nav class="flex flex-wrap items-center gap-6 text-sm text-neutral-600">
				<a class="hover:text-neutral-900" href="#features">Features</a>
				<a class="hover:text-neutral-900" href="#integrations">Integrations</a>
			</nav>
			<div class="flex items-center gap-3">
				<a
					class="rounded-full bg-stone-800 px-4 py-2 text-xs text-neutral-200"
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
			<div class="mt-20 max-w-3xl">
				<h1 class="text-3xl">Built to make property management effortless,</h1>
				<h1 class="text-3xl">Bedrock saves you time and you're in charge.</h1>
				<a
					href="https://calendly.com/21andrewch/30min"
					target="_blank"
					rel="noreferrer"
					class="text-md mt-4 inline-flex flex-row items-center gap-1 rounded-full bg-stone-800 px-5 py-2 text-neutral-200"
				>
					Book a demo
				</a>
			</div>
			<div class="relative overflow-hidden rounded-sm bg-[#0b1e24] p-6">
				<div
					class="pointer-events-none absolute -inset-24 opacity-90 blur-3xl"
					style="background-image: radial-gradient(900px 520px at 25% 25%, rgba(58, 140, 155, 0.95), transparent 62%), radial-gradient(760px 520px at 80% 30%, rgba(40, 92, 120, 0.85), transparent 60%), radial-gradient(760px 520px at 55% 92%, rgba(18, 44, 62, 0.9), transparent 62%);"
				></div>
				<div
					class="pointer-events-none absolute inset-0 opacity-[0.08]"
					style="background-image: repeating-linear-gradient(135deg, rgba(255,255,255,0.35), rgba(255,255,255,0.35) 1px, transparent 1px, transparent 8px);"
				></div>
				<div class="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/10 via-transparent to-black/35"></div>
				<div class="relative z-10 rounded-2xl">
					<div
						class="flex aspect-[16/10] min-h-[240px] w-full items-center justify-center p-4 sm:p-6"
					>
						<div
							class="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-neutral-300 bg-[#f5f4f1] shadow-lg"
						>
							<div
								class="flex items-center justify-between border-b border-neutral-200 bg-[#f0efeb] px-4 py-2 text-xs text-neutral-500"
							>
								<div class="flex items-center gap-1.5">
									<span class="h-2.5 w-2.5 rounded-full bg-[#d7d3cc]"></span>
									<span class="h-2.5 w-2.5 rounded-full bg-[#e1ded7]"></span>
									<span class="h-2.5 w-2.5 rounded-full bg-[#e9e6df]"></span>
								</div>
								<div class="text-[11px] font-semibold tracking-[0.1em] uppercase">Bedrock</div>
								<div class="text-[11px] text-neutral-400"></div>
							</div>
							<div class="grid h-full grid-cols-[0.9fr_1.6fr]">
								<div
									class="border-r border-neutral-200 bg-[#f4f2ee] px-3 py-4 text-xs text-neutral-500 sm:px-4"
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
																? 'bg-[#efece6] text-neutral-900'
																: 'text-neutral-600 hover:bg-[#edeae4] hover:text-neutral-800'
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
									class="flex flex-col gap-4 bg-[#f8f6f2] px-4 py-4 text-sm text-neutral-700 sm:px-6"
								>
									<div class="text-base font-semibold text-neutral-800">
										{demoDetails[activeDemoId].title}
									</div>
									<div
										class="rounded-xl border border-neutral-200 bg-[#fbfaf8] p-4 text-sm text-neutral-700"
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
										class="mt-auto rounded-xl border border-neutral-200 bg-[#fbfaf8] px-3 py-2 text-xs text-neutral-500"
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
				<div
					class="flex min-h-[420px] flex-col rounded-sm bg-[#F2F1EE] p-6"
				>
					<div class="text-sm text-neutral-900">Triage Issues</div>
					<p class="mt-2 text-sm leading-relaxed text-neutral-500">
						Turn tenant messages into a complete work order: priority, missing details, and a clear
						next step.
					</p>
					<div class="mt-6 flex-1 rounded-xl bg-[#d9d6cf] p-6">
						<div class="rounded-xl bg-[#efede7] p-4 text-sm text-neutral-700 shadow-sm">
							<div class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
								Tenant message
							</div>
							<div class="mt-2 text-sm font-medium text-neutral-900">
								"My sink is leaking again."
							</div>
							<div class="mt-3 space-y-2 text-xs text-neutral-600">
								<div class="flex items-center justify-between rounded-lg bg-white/60 px-3 py-2">
									<span>Category</span>
									<span class="font-medium text-neutral-800">Plumbing</span>
								</div>
								<div class="flex items-center justify-between rounded-lg bg-white/60 px-3 py-2">
									<span>Priority</span>
									<span class="font-medium text-neutral-800">Urgent</span>
								</div>
								<div class="flex items-center justify-between rounded-lg bg-white/60 px-3 py-2">
									<span>Next step</span>
									<span class="font-medium text-neutral-800">Ask for photo</span>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div
					class="flex min-h-[420px] flex-col rounded-sm bg-[#F2F1EE] p-6"
				>
					<div class="text-sm text-neutral-900">Dispatch Vendors</div>
					<p class="mt-2 text-sm leading-relaxed text-neutral-500">
						Recommend the right vendor, get availability, schedule access, and keep tenants updated.
					</p>
					<div class="mt-6 flex-1 rounded-xl bg-[#cfd6cf] p-6">
						<div class="rounded-xl bg-[#efede7] p-4 text-sm text-neutral-700 shadow-sm">
							<div class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
								Vendor outreach
							</div>
							<div class="mt-2 text-sm font-medium text-neutral-900">Email drafted</div>
							<div class="mt-3 space-y-2 text-xs">
								<div
									class="flex items-center justify-between rounded-lg bg-white/60 px-3 py-2 text-neutral-700"
								>
									<span>Suggested vendor</span>
									<span class="font-medium text-neutral-800">Ace Plumbing</span>
								</div>
								<div
									class="flex items-center justify-between rounded-lg bg-white/60 px-3 py-2 text-neutral-700"
								>
									<span>Availability</span>
									<span class="font-medium text-neutral-800">Today 2–4pm</span>
								</div>
								<div
									class="flex items-center justify-between rounded-lg bg-white/60 px-3 py-2 text-neutral-700"
								>
									<span>Tenant update</span>
									<span class="font-medium text-neutral-800">Drafted</span>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div
					class="flex min-h-[420px] flex-col rounded-sm bg-[#F2F1EE] p-6"
				>
					<div class="text-sm text-neutral-900">Process Invoices</div>
					<p class="mt-2 text-sm leading-relaxed text-neutral-500">
						Extract invoice details, match to the job, flag surprises, and prep for approval and
						payment.
					</p>
					<div class="mt-6 flex-1 rounded-xl bg-[#cfd3d6] p-6">
						<div class="rounded-xl bg-[#efede7] p-4 text-sm text-neutral-700 shadow-sm">
							<div class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
								Payable created
							</div>
							<div class="mt-2 text-sm font-medium text-neutral-900">Summary</div>
							<div class="mt-3 space-y-2 text-xs">
								<div
									class="flex items-center justify-between rounded-lg bg-white/60 px-3 py-2 text-neutral-700"
								>
									<span>Total</span>
									<span class="font-medium text-neutral-800">$285.00</span>
								</div>
								<div
									class="flex items-center justify-between rounded-lg bg-white/60 px-3 py-2 text-neutral-700"
								>
									<span>Matched to</span>
									<span class="font-medium text-neutral-800">WO #1842</span>
								</div>
								<div
									class="flex items-center justify-between rounded-lg bg-white/60 px-3 py-2 text-neutral-700"
								>
									<span>Flag</span>
									<span class="font-medium text-neutral-800">Labor +20%</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>

		<section class="grid scroll-mt-28 gap-10 lg:grid-cols-[0.9fr_1.6fr] rounded-sm py-2 px-4 bg-[#F2F1EE]" id="integrations">
			<div class="max-w-sm flex flex-col justify-center">
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
					<div class="absolute inset-0 bg-gradient-to-t from-[#f6f5f3]/75 via-transparent to-transparent"></div>

					<div class="relative h-full w-full p-6 sm:p-8">
						<div
							class="absolute left-[12%] top-[20%] w-[74%] max-w-[720px] rounded-2xl border border-neutral-200 bg-[#fbfaf8] shadow-2xl"
						>
							<div
								class="flex items-center justify-between border-b rounded-t-2xl border-neutral-200 bg-[#f3f2ee] px-4 py-2 text-xs text-neutral-500"
							>
								<div class="flex items-center gap-1.5">
									<span class="h-2.5 w-2.5 rounded-full bg-[#d7d3cc]"></span>
									<span class="h-2.5 w-2.5 rounded-full bg-[#e1ded7]"></span>
									<span class="h-2.5 w-2.5 rounded-full bg-[#e9e6df]"></span>
								</div>
								<div class="text-[11px] font-semibold tracking-[0.1em] uppercase">Gmail</div>
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
									<span class="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700"
										>Edit</span
									>
									<span class="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700"
										>Deny</span
									>
								</div>
							</div>
						</div>

						<div
							class="absolute right-[8%] top-[12%] hidden h-[84%] w-[38%] max-w-[320px] rounded-[38px] border border-neutral-200 bg-[#fbfaf8] shadow-2xl sm:block"
						>
							<div class="flex items-center justify-between px-6 pt-5 text-xs text-neutral-500">
								<div class="text-[11px] font-semibold tracking-[0.1em] uppercase">AppFolio</div>
								<div class="rounded-full bg-neutral-100 px-2 py-1 text-[11px]">Synced</div>
							</div>
							<div class="px-6 pb-6 pt-4">
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

		<section class="flex mt-20 scroll-my-28 flex-col items-center gap-4 text-center" id="request-demo">
			<h2 class="text-6xl font-medium">Try Bedrock now.</h2>
			<a
				class="rounded-full bg-neutral-900 px-6 py-2.5 text-sm text-neutral-100"
				href="https://calendly.com/21andrewch/30min"
				target="_blank"
				rel="noreferrer"
			>
				Book a demo
			</a>
		</section>
	</div>

	<footer class="bg-[#F2F1EE]">
		<div class="mx-auto w-full max-w-7xl px-6 py-10 text-sm text-neutral-600">
			© {new Date().getFullYear()} Bedrock PMS
		</div>
	</footer>
</div>
