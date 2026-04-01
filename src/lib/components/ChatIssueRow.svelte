<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { peopleMembersCache } from '$lib/stores/peopleMembersCache';

	export let issue;

	let hoverTooltipVisible = false;
	let hoverTooltipX = 0;
	let hoverTooltipY = 0;
	const tooltipOffset = 12;
	const tooltipWidth = 120;
	const clampX = (value) => {
		if (typeof window === 'undefined') return value;
		const max = window.innerWidth - tooltipWidth - 8;
		return Math.max(8, Math.min(value, max));
	};

	const statusClassByKey = {
		todo: 'border-neutral-500',
		in_progress: 'border-orange-500',
		done: 'border-emerald-500'
	};

	const avatarPalette = [
		'bg-amber-200',
		'bg-blue-200',
		'bg-emerald-200',
		'bg-rose-200',
		'bg-indigo-200',
		'bg-teal-200',
		'bg-orange-200',
		'bg-sky-200'
	];

	const getAvatarColor = (seed) => {
		if (!seed) return 'bg-neutral-200';
		const value = seed.toString();
		let hash = 0;
		for (let i = 0; i < value.length; i += 1) {
			hash = (hash * 31 + value.charCodeAt(i)) % avatarPalette.length;
		}
		return avatarPalette[hash] ?? 'bg-neutral-200';
	};

	const getAssigneeBadge = (assigneeId, membersMap) => {
		const member = assigneeId ? membersMap[assigneeId] : null;
		const name = member?.users?.name ?? member?.name ?? 'Assigned';
		const initial = (name ?? 'U').toString().trim().charAt(0).toUpperCase() || 'U';
		const color = getAvatarColor(assigneeId ?? name);
		if (!assigneeId) return null;
		return { name, initial, color };
	};

	const slugify = (value) =>
		value
			?.toString()
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, '')
			.trim()
			.replace(/\s+/g, '-');

	$: membersByUserId = Array.isArray($peopleMembersCache?.data)
		? $peopleMembersCache.data.reduce((acc, member) => {
				if (member?.user_id) acc[member.user_id] = member;
				return acc;
			}, {})
		: {};
	$: assigneeBadge = getAssigneeBadge(issue?.assigneeId ?? issue?.assignee_id, membersByUserId);
	$: issueHref = issue?.readableId
		? `/${$page.params.workspace}/issue/${issue.readableId}/${slugify(issue.title ?? issue.name ?? '')}`
		: issue?.id
			? `/${$page.params.workspace}/issue/${issue.id}/${slugify(issue.title ?? issue.name ?? '')}`
			: '#';
</script>

<a
	href={issueHref}
	class="group block w-full px-4 py-2 text-left transition hover:bg-stone-50"
	data-sveltekit-preload-data="hover"
	on:mouseenter={(event) => {
		hoverTooltipVisible = true;
		const rect = event.currentTarget.getBoundingClientRect();
		hoverTooltipX = clampX(event.clientX + tooltipOffset);
		hoverTooltipY = rect.bottom + 8;
	}}
	on:mousemove={(event) => {
		hoverTooltipX = clampX(event.clientX + tooltipOffset);
	}}
	on:mouseleave={() => {
		hoverTooltipVisible = false;
	}}
>
	<div class="relative flex w-full min-w-0 items-center gap-4">
		<div class="relative z-0 flex min-w-0 flex-1 items-center gap-2">
			<div class="relative">
				<span class="-m-1 flex items-center justify-center rounded-md p-1">
					<span
						class={`flex shrink-0 items-center justify-center leading-none ${
							issue?.urgent ? 'text-rose-500' : 'text-neutral-400'
						}`}
						style="width: 16px; height: 16px;"
					>
						{#if issue?.urgent}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								fill="currentColor"
								viewBox="0 0 16 16"
							>
								<path
									d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm6 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
								/>
							</svg>
						{:else}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								fill="currentColor"
								viewBox="0 0 16 16"
							>
								<path
									d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm2.5 7.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1"
								/>
							</svg>
						{/if}
					</span>
				</span>
			</div>
			<div class="relative">
				<span class="-m-1 flex items-center justify-center rounded-md p-1">
					<span
						class={`box-border inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-2 ${
							statusClassByKey[issue?.status] ?? 'border-neutral-400'
						}`}
					></span>
				</span>
			</div>
			<div class="relative flex min-w-0 flex-1 items-center gap-2">
				<span class="text-base whitespace-nowrap text-neutral-800">
					{issue?.title ?? issue?.name ?? 'Issue'}
				</span>
			</div>
		</div>
		<div
			class="pointer-events-auto absolute top-1/2 right-0 z-20 flex -translate-y-1/2 items-center gap-2 pl-6 transition-opacity duration-75 ease-out group-hover:pointer-events-none group-hover:opacity-0"
		>
			<div
				class="inline-flex items-center overflow-hidden rounded-full border border-neutral-200 bg-white text-xs text-neutral-500"
			>
				<span class="hidden truncate px-2 py-1 whitespace-nowrap sm:inline">
					{issue?.property ?? 'Unknown'}
				</span>
				<span
					class="hidden truncate border-l border-neutral-200 px-2 py-1 whitespace-nowrap sm:inline"
				>
					{issue?.unit ?? 'Unknown'}
				</span>
				<span class="truncate px-2 py-1 whitespace-nowrap sm:hidden">
					{issue?.unit ?? 'Unknown'}
				</span>
			</div>
			{#if assigneeBadge}
				<div
					class={`hidden h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold text-neutral-700 sm:flex ${assigneeBadge.color}`}
					aria-label={assigneeBadge.name}
					title={assigneeBadge.name}
				>
					{assigneeBadge.initial}
				</div>
			{:else}
				<div
					class="hidden h-6 w-6 items-center justify-center rounded-full text-neutral-300 sm:flex"
					aria-label="Unassigned"
					title="Unassigned"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="18"
						height="18"
						fill="currentColor"
						class="bi bi-person-circle"
						viewBox="0 0 16 16"
					>
						<path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0" />
						<path
							fill-rule="evenodd"
							d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1"
						/>
					</svg>
				</div>
			{/if}
		</div>
	</div>
	{#if hoverTooltipVisible}
		<div
			class="fixed z-50 rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] whitespace-nowrap text-white shadow-sm"
			style={`left: ${hoverTooltipX}px; top: ${hoverTooltipY}px;`}
		>
			Go to issue
		</div>
	{/if}
</a>
