<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { supabase } from '$lib/supabaseClient';
	import { getContext } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import SidebarButton from '$lib/components/SidebarButton.svelte';
	import {
		applyPolicyInsert,
		applyPolicyUpdate,
		policiesCache,
		primePoliciesCache
	} from '$lib/stores/policiesCache';

	export let data;

	const tabs = ['All policies'];
	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();
	let showNewPolicyModal = false;
	let newPolicyType = 'urgency';
	let newPolicyUrgency = 'urgent';
	let newPolicyMaintenanceIssue = '';
	let editingPolicyId = null;
	let selectedPolicy = null;
	let createPolicyError = '';
	let creatingPolicy = false;
	let toneRefreshTimer = null;
	let filterOpen = false;
	let filterCategoryOpen = false;
	let filterValueOpen = false;
	let filterCategory = 'type';
	let filterValue = 'any';
	let _resolvedPolicies = null;

	$: workspaceSlug = $page.params.workspace;

	$: _cachedPolicies =
		$policiesCache?.workspace === $page.params.workspace && $policiesCache?.data
			? $policiesCache.data
			: null;
	$: {
		if (data.policies instanceof Promise) {
			const loadStartedAt = Date.now();
			data.policies.then((result) => {
				if (result?.policies) {
					primePoliciesCache($page.params.workspace, result, loadStartedAt);
				}
			});
		} else if (data.policies) {
			primePoliciesCache($page.params.workspace, data.policies);
		}
	}
	$: {
		const list = _cachedPolicies?.policies ?? _cachedPolicies ?? [];
		_resolvedPolicies = Array.isArray(list) ? list : [];
	}
	$: policies = _resolvedPolicies ?? [];

	const policyTypeOptions = [{ value: 'urgency', label: 'Urgency' }];
	const policyTypeFilterOptions = [
		{ value: 'urgency', label: 'Urgency' },
		{ value: 'tone', label: 'Tone' }
	];
	const policyTypeLabels = {
		urgency: 'Urgency',
		tone: 'Tone'
	};
	const policyTypeStyles = {
		urgency: 'border-rose-200 bg-rose-50 text-rose-700',
		tone: 'border-emerald-200 bg-emerald-50 text-emerald-700'
	};
	const maintenanceIssueOptions = [
		'toilet clog',
		'toilet leak',
		'sink clog',
		'sink leak',
		'shower drain',
		'tub drain',
		'faucet leak',
		'pipe leak',
		'garbage disposal',
		'water heater',
		'AC unit',
		'heater outage',
		'thermostat issue',
		'dishwasher drain',
		'refrigerator cooling',
		'oven heat',
		'stove burner',
		'microwave issue',
		'washer leak',
		'dryer heat',
		'ceiling leak',
		'wall damage',
		'mold growth',
		'smoke detector',
		'CO detector',
		'outlet failure',
		'breaker trip',
		'window lock',
		'sliding door',
		'door lock',
		'cabinet hinge',
		'closet track',
		'exhaust fan',
		'ceiling fan',
		'blinds damage',
		'intercom issue',
		'garbage chute',
		'ant infestation',
		'roach infestation',
		'balcony door'
	];
	const filterCategories = [{ value: 'type', label: 'Type' }];

	let filterValueOptions = [];
	$: {
		if (filterCategory === 'type') {
			filterValueOptions = [{ value: 'any', label: 'Any type' }, ...policyTypeFilterOptions];
		} else {
			filterValueOptions = [{ value: 'any', label: 'Any' }];
		}
	}
	$: selectedCategory =
		filterCategories.find((option) => option.value === filterCategory) ?? filterCategories[0];
	$: {
		if (!filterValueOptions.some((option) => option.value === filterValue)) {
			filterValue = filterValueOptions[0]?.value ?? 'any';
		}
	}
	$: selectedValue =
		filterValueOptions.find((option) => option.value === filterValue) ?? filterValueOptions[0];

	const formatMaintenanceIssue = (value) =>
		typeof value === 'string' && value.trim() ? value.trim() : 'Maintenance issue';

	const formatMaintenanceIssueTitle = (value) => {
		const issue = formatMaintenanceIssue(value);
		return issue ? issue.charAt(0).toUpperCase() + issue.slice(1) : issue;
	};

	const formatMaintenanceIssueDescription = (value) => formatMaintenanceIssue(value).toLowerCase();

	const buildBehaviorDescription = (policy) => {
		if (policy?.type === 'tone') {
			const status = policy?.meta?.ai_prompt_status ?? 'pending';
			if (policy?.meta?.ai_prompt) return policy.meta.ai_prompt;
			if (status === 'error') return 'Tone description failed to generate.';
			return 'Generating tone description...';
		}
		if (policy?.type !== 'urgency') return policy?.description || 'No description';
		const issue = formatMaintenanceIssueDescription(
			policy?.meta?.maintenance_issue ?? policy?.description
		);
		const urgency = policy?.meta?.urgency;
		if (urgency === 'urgent') {
			return `The agent will immediately schedule a vendor for ${issue}.`;
		}
		if (urgency === 'not_urgent') {
			return `The agent won't immediately schedule a vendor for ${issue}.`;
		}
		return `Policy applies to ${issue}.`;
	};

	$: filteredPolicies = policies.filter((policy) => {
		if (filterCategory === 'type') {
			if (filterValue === 'any') return true;
			return String(policy.type ?? '') === String(filterValue);
		}
		return true;
	});
	$: hasActiveFilter = filterValue !== 'any';

	const formatDate = (value) => {
		if (!value) return '—';
		const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : value;
		if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		}).format(date);
	};

	$: canSubmit = Boolean(newPolicyMaintenanceIssue.trim());
	$: maintenanceIssueLabel = newPolicyMaintenanceIssue.trim();
	$: behaviorDescription =
		maintenanceIssueLabel && newPolicyType === 'urgency'
			? newPolicyUrgency === 'urgent'
				? `The agent will immediately schedule a vendor for ${maintenanceIssueLabel}.`
				: `The agent won't immediately schedule a vendor for ${maintenanceIssueLabel}.`
			: '';

	const openNewPolicyModal = () => {
		showNewPolicyModal = true;
		editingPolicyId = null;
		selectedPolicy = null;
		createPolicyError = '';
		if (!newPolicyType) newPolicyType = 'urgency';
	};

	const closeNewPolicyModal = () => {
		showNewPolicyModal = false;
		newPolicyType = 'urgency';
		newPolicyUrgency = 'urgent';
		newPolicyMaintenanceIssue = '';
		editingPolicyId = null;
		selectedPolicy = null;
		createPolicyError = '';
		if (toneRefreshTimer) {
			clearTimeout(toneRefreshTimer);
			toneRefreshTimer = null;
		}
		document.activeElement?.blur();
	};

	const openEditPolicyModal = (policy) => {
		if (!policy) return;
		showNewPolicyModal = true;
		editingPolicyId = policy.id ?? null;
		selectedPolicy = policy;
		newPolicyType = policy.type ?? 'urgency';
		newPolicyUrgency = policy?.meta?.urgency ?? 'urgent';
		newPolicyMaintenanceIssue = policy?.meta?.maintenance_issue ?? policy?.description ?? '';
		createPolicyError = '';
		if (policy.type === 'tone') {
			refreshTonePolicy(policy.id);
		}
	};

	const refreshTonePolicy = async (policyId) => {
		if (!policyId) return;
		try {
			const { data, error } = await supabase
				.from('workspace_policies')
				.select(
					'id, type, email, description, meta, created_at, created_by, users:created_by(name)'
				)
				.eq('id', policyId)
				.maybeSingle();
			if (error || !data?.id) return;
			selectedPolicy = {
				id: data.id,
				type: data.type ?? 'tone',
				email: data.email ?? '',
				description: data.description ?? '',
				meta: data.meta ?? null,
				createdAt: data.created_at ?? null,
				createdById: data.created_by ?? null,
				createdByName: data.users?.name ?? 'Unknown'
			};
		} catch {
			// ignore refresh failures
		}
	};

	$: if (selectedPolicy?.type === 'tone' && tonePromptStatus === 'pending') {
		if (!toneRefreshTimer) {
			toneRefreshTimer = setTimeout(() => {
				toneRefreshTimer = null;
				refreshTonePolicy(selectedPolicy?.id);
			}, 2500);
		}
	}

	const splitDiffColumns = (segments) => {
		const original = [];
		const updated = [];
		(segments ?? []).forEach((segment) => {
			if (!segment?.text) return;
			if (segment.type !== 'insert') original.push(segment);
			if (segment.type !== 'delete') updated.push(segment);
		});
		return { original, updated };
	};

	$: toneDiffSegments = Array.isArray(selectedPolicy?.meta?.diff) ? selectedPolicy.meta.diff : [];
	$: toneDiffColumns = splitDiffColumns(toneDiffSegments);
	$: tonePromptStatus = selectedPolicy?.meta?.ai_prompt_status ?? 'pending';
	$: tonePromptError = selectedPolicy?.meta?.ai_prompt_error ?? '';
	$: tonePrompt = selectedPolicy?.meta?.ai_prompt ?? '';

	const closeFilterMenus = () => {
		filterOpen = false;
		filterCategoryOpen = false;
		filterValueOpen = false;
	};

	const handleFilterCategorySelect = (next) => {
		filterCategory = next;
		filterValue = 'any';
		filterCategoryOpen = false;
		filterValueOpen = false;
	};

	const handleFilterValueSelect = (next) => {
		filterValue = next;
		filterValueOpen = false;
	};

	const onWindowClick = () => {
		if (filterOpen || filterCategoryOpen || filterValueOpen) closeFilterMenus();
	};

	const handleCreatePolicy = async () => {
		createPolicyError = '';
		creatingPolicy = true;
		try {
			const response = await fetch('/api/policies', {
				method: editingPolicyId ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: editingPolicyId,
					workspace: workspaceSlug,
					type: newPolicyType,
					urgency: newPolicyType === 'urgency' ? newPolicyUrgency : null,
					maintenance_issue: newPolicyMaintenanceIssue.trim() || null,
					email: null,
					description: null
				})
			});
			const result = await response.json();
			if (!response.ok) {
				createPolicyError = result?.error ?? 'Unable to create policy.';
				return;
			}
			if (editingPolicyId) {
				applyPolicyUpdate(result);
			} else {
				applyPolicyInsert(result);
			}
			closeNewPolicyModal();
		} catch {
			createPolicyError = 'Unable to create policy.';
		} finally {
			creatingPolicy = false;
		}
	};

	const onKeydown = (event) => {
		if (event.key === 'Escape' && showNewPolicyModal) {
			closeNewPolicyModal();
		}
	};
</script>

<svelte:window on:click={onWindowClick} on:keydown={onKeydown} />

<div>
	<div class="flex items-center justify-between border-b border-neutral-200 px-6 py-2.5">
		<div class="flex items-center gap-2">
			<button
				type="button"
				aria-label="Open sidebar"
				class="rounded-md p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800 lg:hidden"
				on:click={openSidebar}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="12"
					height="12"
					fill="currentColor"
					class="bi bi-layout-sidebar"
					viewBox="0 0 16 16"
				>
					<path
						d="M0 3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm5-1v12h9a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zM4 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h2z"
					/>
				</svg>
			</button>
			<h1 class="text-sm font-normal text-neutral-700">Policies</h1>
		</div>
		<div class="flex items-center gap-2">
			<button
				type="button"
				class="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
				on:click={openNewPolicyModal}
			>
				+ New policy
			</button>
			<SidebarButton />
		</div>
	</div>
	<div class="flex items-center justify-between px-6 py-2">
		<div class="flex items-center gap-2">
			{#each tabs as tab}
				<button
					class={`rounded-md border px-2.5 py-1 text-xs transition ${
						tab === 'All policies'
							? 'border-neutral-200 bg-neutral-100 text-neutral-700'
							: 'border-neutral-200 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700'
					}`}
					type="button"
				>
					{tab}
				</button>
			{/each}
		</div>
		<div class="flex items-center gap-4 text-xs text-neutral-500">
			<div class="relative" on:click|stopPropagation>
				<button
					class="inline-flex items-center gap-2 hover:text-neutral-800"
					type="button"
					aria-expanded={filterOpen}
					on:click|stopPropagation={() => {
						filterOpen = !filterOpen;
						filterCategoryOpen = false;
						filterValueOpen = false;
					}}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						fill="currentColor"
						viewBox="0 0 16 16"
					>
						<path
							d="M6 10.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"
						/>
					</svg>
					Filter
				</button>
				{#if filterOpen}
					<div
						class="absolute right-0 z-20 mt-2 w-72 origin-top-right rounded-md border border-neutral-200 bg-white py-2 text-xs text-neutral-700 shadow-lg"
						on:click|stopPropagation
					>
						<div class="flex items-center gap-2 px-3 py-2">
							<div class="relative flex-1">
								<button
									type="button"
									class="flex w-full items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-left text-xs text-neutral-700 transition hover:bg-neutral-50"
									on:click|stopPropagation={() => {
										filterCategoryOpen = !filterCategoryOpen;
										filterValueOpen = false;
									}}
								>
									<span class="truncate">{selectedCategory?.label ?? 'Category'}</span>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="12"
										height="12"
										fill="currentColor"
										viewBox="0 0 16 16"
									>
										<path
											d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
										/>
									</svg>
								</button>
								{#if filterCategoryOpen}
									<div
										class="absolute left-0 z-30 mt-2 w-full rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
										on:click|stopPropagation
									>
										{#each filterCategories as option}
											<button
												type="button"
												class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
													filterCategory === option.value ? 'bg-neutral-50' : ''
												}`}
												on:click|stopPropagation={() => handleFilterCategorySelect(option.value)}
											>
												<span>{option.label}</span>
												{#if filterCategory === option.value}
													<span class="text-[10px] text-neutral-400">Selected</span>
												{/if}
											</button>
										{/each}
									</div>
								{/if}
							</div>
							<div class="relative flex-1">
								<button
									type="button"
									disabled={!filterValueOptions.length}
									class={`flex w-full items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-left text-xs text-neutral-700 transition hover:bg-neutral-50 ${
										filterValueOptions.length ? '' : 'cursor-not-allowed opacity-60'
									}`}
									on:click|stopPropagation={() => {
										if (!filterValueOptions.length) return;
										filterValueOpen = !filterValueOpen;
										filterCategoryOpen = false;
									}}
								>
									<span class="truncate">{selectedValue?.label ?? 'Value'}</span>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="12"
										height="12"
										fill="currentColor"
										viewBox="0 0 16 16"
									>
										<path
											d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"
										/>
									</svg>
								</button>
								{#if filterValueOpen}
									{#key filterCategory}
										<div
											class="absolute left-0 z-30 mt-2 w-full rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-lg"
											on:click|stopPropagation
										>
											{#each filterValueOptions as option}
												<button
													type="button"
													class={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 ${
														filterValue === option.value ? 'bg-neutral-50' : ''
													}`}
													on:click={() => handleFilterValueSelect(option.value)}
												>
													<span>{option.label}</span>
													{#if filterValue === option.value}
														<span class="text-[10px] text-neutral-400">Selected</span>
													{/if}
												</button>
											{/each}
										</div>
									{/key}
								{/if}
							</div>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>

	{#if _resolvedPolicies === null}
		<div class="divide-y divide-neutral-100">
			{#each { length: 4 } as _}
				<div class="flex items-center gap-3 px-6 py-2">
					<div class="skeleton h-3 w-20 rounded-full"></div>
					<div class="skeleton h-4 w-2/5"></div>
					<div class="skeleton ml-auto h-5 w-24 rounded-full"></div>
					<div class="skeleton h-4 w-16 rounded-full"></div>
				</div>
			{/each}
		</div>
	{:else if filteredPolicies.length === 0}
		<div class="px-6 py-8 text-sm text-neutral-400">
			{hasActiveFilter ? 'No policies match the current filter.' : 'No policies yet.'}
		</div>
	{:else}
		<div>
			{#each filteredPolicies as policy}
				<div
					class="flex cursor-pointer items-center justify-between gap-4 px-6 py-2 transition hover:bg-neutral-50"
					on:click={() => openEditPolicyModal(policy)}
				>
					<div class="flex min-w-0 items-center gap-3">
						<span
							class={`inline-flex h-5 items-center rounded-full border px-2 text-[10px] font-semibold tracking-wide uppercase ${
								policyTypeStyles[policy.type] ??
								'border-neutral-200 bg-neutral-100 text-neutral-600'
							}`}
						>
							{policyTypeLabels[policy.type] ?? policy.type ?? 'Policy'}
						</span>
						<div class="min-w-0">
							<div class="truncate text-sm text-neutral-800">
								{formatMaintenanceIssueTitle(
									policy?.meta?.maintenance_issue ?? policy?.description
								)}
							</div>
							<div class="truncate text-xs text-neutral-400">
								{buildBehaviorDescription(policy)}
							</div>
						</div>
					</div>
					<div class="flex shrink-0 items-center gap-3 text-xs text-neutral-500">
						<span class="hidden sm:inline">{formatDate(policy.createdAt)}</span>
						<span class="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-500">
							{policy.createdByName ?? 'Unknown'}
						</span>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

{#if showNewPolicyModal}
	<div
		class="fixed inset-0 z-40 bg-neutral-900/20"
		transition:fade={{ duration: 120 }}
		on:click={closeNewPolicyModal}
	></div>
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
		<div
			class={`pointer-events-auto w-full rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl ${
				selectedPolicy?.type === 'tone' ? 'max-w-4xl' : 'max-w-sm'
			}`}
			transition:scale={{ duration: 140, start: 0.9 }}
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
		>
			{#if selectedPolicy?.type === 'tone'}
				<div class="flex items-center justify-between">
					<div>
						<div class="text-lg font-medium text-neutral-800">Tone policy</div>
						<div class="text-xs text-neutral-500">
							{formatMaintenanceIssueTitle(
								selectedPolicy?.meta?.maintenance_issue ?? selectedPolicy?.description
							)}
						</div>
					</div>
					<button
						class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
						on:click={closeNewPolicyModal}
						type="button"
						aria-label="Close"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="24"
							height="24"
							fill="currentColor"
							viewBox="0 0 16 16"
						>
							<path
								d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"
							/>
						</svg>
					</button>
				</div>
				<div class="mt-5">
					<div class="mb-2 text-xs text-neutral-500">
						Tone policies are created from email drafts and are read-only here.
					</div>
					<div class="grid gap-4 md:grid-cols-2">
						<div>
							<div class="text-xs font-semibold text-neutral-600">Original</div>
							<div
								class="mt-2 max-h-80 overflow-auto rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm whitespace-pre-wrap text-neutral-700"
							>
								{#if toneDiffColumns.original.length}
									{#each toneDiffColumns.original as segment}
										<span
											class={segment.type === 'delete'
												? 'rounded-sm bg-rose-100 text-rose-800'
												: ''}
										>
											{segment.text}
										</span>
									{/each}
								{:else}
									<span class="text-neutral-400">No diff data available.</span>
								{/if}
							</div>
						</div>
						<div>
							<div class="text-xs font-semibold text-neutral-600">Current</div>
							<div
								class="mt-2 max-h-80 overflow-auto rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm whitespace-pre-wrap text-neutral-700"
							>
								{#if toneDiffColumns.updated.length}
									{#each toneDiffColumns.updated as segment}
										<span
											class={segment.type === 'insert'
												? 'rounded-sm bg-emerald-100 text-emerald-800'
												: ''}
										>
											{segment.text}
										</span>
									{/each}
								{:else}
									<span class="text-neutral-400">No diff data available.</span>
								{/if}
							</div>
						</div>
					</div>
					<div class="mt-4">
						<div class="text-xs font-semibold text-neutral-600">Tone description</div>
						<p
							class="mt-2 rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-2.5 text-sm text-neutral-700"
						>
							{#if tonePrompt}
								{tonePrompt}
							{:else if tonePromptStatus === 'error'}
								{tonePromptError || 'Tone description failed to generate.'}
							{:else}
								Generating tone description...
							{/if}
						</p>
					</div>
					<div class="mt-5 flex items-center justify-end">
						<button
							class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
							on:click={closeNewPolicyModal}
							type="button"
						>
							Close
						</button>
					</div>
				</div>
			{:else}
				<form on:submit|preventDefault={handleCreatePolicy}>
					<div class="flex items-center justify-between">
						<div class="text-lg font-medium text-neutral-800">
							{editingPolicyId ? 'Edit policy' : 'New policy'}
						</div>
						<button
							class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
							on:click={closeNewPolicyModal}
							type="button"
							aria-label="Close"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="24"
								height="24"
								fill="currentColor"
								viewBox="0 0 16 16"
							>
								<path
									d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"
								/>
							</svg>
						</button>
					</div>
					<div class="mt-5 flex flex-col gap-3">
						{#if createPolicyError}
							<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">
								{createPolicyError}
							</p>
						{/if}
						<div>
							<label class="text-xs text-neutral-500">Maintenance issue</label>
							<input
								class="mt-1 w-full rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
								placeholder="Add maintenance issue"
								bind:value={newPolicyMaintenanceIssue}
								type="text"
								required
							/>
						</div>
						<div>
							<label class="text-xs text-neutral-500">Type</label>
							<select
								class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
								bind:value={newPolicyType}
								required
							>
								{#each policyTypeOptions as option}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</div>
						{#if newPolicyType === 'urgency'}
							<div>
								<label class="text-xs text-neutral-500">Urgency</label>
								<select
									class="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
									bind:value={newPolicyUrgency}
									required
								>
									<option value="urgent">Urgent</option>
									<option value="not_urgent">Not urgent</option>
								</select>
							</div>
						{/if}
						{#if behaviorDescription}
							<p
								class="rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-2.5 text-xs text-neutral-600"
							>
								{behaviorDescription}
							</p>
						{/if}
					</div>
					<div class="mt-5 flex items-center justify-end gap-2">
						<button
							class="rounded-xl border border-stone-200 px-4 py-2 text-sm text-neutral-600 transition-colors hover:bg-stone-50 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
							on:click={closeNewPolicyModal}
							type="button"
						>
							Cancel
						</button>
						<button
							class="rounded-xl bg-stone-800 px-4 py-2 text-sm text-neutral-200 transition-colors hover:bg-stone-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
							disabled={creatingPolicy || !canSubmit}
							type="submit"
						>
							{creatingPolicy
								? editingPolicyId
									? 'Saving...'
									: 'Creating...'
								: editingPolicyId
									? 'Save policy'
									: 'Create policy'}
						</button>
					</div>
				</form>
			{/if}
		</div>
	</div>
{/if}
