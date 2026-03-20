<script>
	// @ts-nocheck
	import { page } from '$app/stores';
	import { getContext } from 'svelte';
	import { fade, scale } from 'svelte/transition';

	export let data;

	const tabs = ['All policies'];
	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();
	let showNewPolicyModal = false;
	let newPolicyType = 'allow';
	let newPolicyEmail = '';
	let newPolicyDescription = '';
	let createPolicyError = '';
	let creatingPolicy = false;
	let filterOpen = false;
	let filterCategoryOpen = false;
	let filterValueOpen = false;
	let filterCategory = 'type';
	let filterValue = 'any';
	let _resolvedPolicies = null;

	$: workspaceSlug = $page.params.workspace;

	$: {
		const policiesData = data.policies;
		const list = policiesData?.policies ?? policiesData;
		_resolvedPolicies = Array.isArray(list) ? list : [];
	}
	$: policies = _resolvedPolicies ?? [];

	const policyTypeOptions = [
		{ value: 'allow', label: 'Allow' },
		{ value: 'block', label: 'Block' },
		{ value: 'behavior', label: 'Behavior' }
	];
	const policyTypeLabels = {
		allow: 'Allow',
		block: 'Block',
		behavior: 'Behavior'
	};
	const policyTypeStyles = {
		allow: 'border-emerald-200 bg-emerald-50 text-emerald-700',
		block: 'border-rose-200 bg-rose-50 text-rose-700',
		behavior: 'border-amber-200 bg-amber-50 text-amber-700'
	};
	const filterCategories = [{ value: 'type', label: 'Type' }];

	let filterValueOptions = [];
	$: {
		if (filterCategory === 'type') {
			filterValueOptions = [{ value: 'any', label: 'Any type' }, ...policyTypeOptions];
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

	const normalizeEmail = (value) => (typeof value === 'string' ? value.trim() : '');
	const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
	$: emailRequired = newPolicyType === 'allow' || newPolicyType === 'block';
	$: normalizedEmail = normalizeEmail(newPolicyEmail);
	$: emailLooksValid = normalizedEmail ? isValidEmail(normalizedEmail) : false;
	$: canSubmit = !emailRequired || emailLooksValid;

	const openNewPolicyModal = () => {
		showNewPolicyModal = true;
		createPolicyError = '';
		if (!newPolicyType) newPolicyType = 'allow';
	};

	const closeNewPolicyModal = () => {
		showNewPolicyModal = false;
		newPolicyType = 'allow';
		newPolicyEmail = '';
		newPolicyDescription = '';
		createPolicyError = '';
		document.activeElement?.blur();
	};

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
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace: workspaceSlug,
					type: newPolicyType,
					email: normalizedEmail || null,
					description: newPolicyDescription.trim()
				})
			});
			const result = await response.json();
			if (!response.ok) {
				createPolicyError = result?.error ?? 'Unable to create policy.';
				return;
			}
			if (!Array.isArray(_resolvedPolicies)) _resolvedPolicies = [];
			_resolvedPolicies = [result, ..._resolvedPolicies];
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
		<button
			type="button"
			class="rounded-md px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
			on:click={openNewPolicyModal}
		>
			+ New policy
		</button>
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
		<div class="divide-y divide-neutral-100">
			{#each filteredPolicies as policy}
				<div class="flex items-center justify-between gap-4 px-6 py-2">
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
								{policy.email || 'All senders'}
							</div>
							<div class="truncate text-xs text-neutral-400">
								{policy.description || 'No description'}
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
			class="pointer-events-auto w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl"
			transition:scale={{ duration: 140, start: 0.9 }}
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
		>
			<form on:submit|preventDefault={handleCreatePolicy}>
				<div class="flex items-center justify-between">
					<div class="text-lg font-medium text-neutral-800">New policy</div>
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
					<div>
						<label class="text-xs text-neutral-500">Sender email</label>
						<input
							class={`mt-1 w-full rounded-xl border px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500 ${
								emailRequired && normalizedEmail && !emailLooksValid
									? 'border-red-300'
									: 'border-stone-300'
							}`}
							placeholder={emailRequired ? 'name@company.com' : 'Optional'}
							bind:value={newPolicyEmail}
							type="email"
						/>
						{#if emailRequired}
							<p class="mt-1 text-[11px] text-neutral-400">
								Required for allow and block policies.
							</p>
						{/if}
					</div>
					<textarea
						class="min-h-[96px] rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="Description (optional)"
						name="description"
						bind:value={newPolicyDescription}
					></textarea>
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
						{creatingPolicy ? 'Creating...' : 'Create policy'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
