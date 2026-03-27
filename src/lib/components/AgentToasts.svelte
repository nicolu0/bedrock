<script>
	// @ts-nocheck
	import { fade, fly } from 'svelte/transition';
	import { agentToasts } from '$lib/stores/agentToasts';
	import { issuesCache } from '$lib/stores/issuesCache';
	import { page } from '$app/stores';

	$: issuesById = new Map(
		($issuesCache.data?.issues ?? []).map((issue) => [issue.id ?? issue.issueId, issue])
	);
	const FALLBACK_LABEL = 'New maintenance request';
	const lastLabels = new Map();
	const getIssueLabel = (toast) => {
		const propertyFromToast = toast?.propertyName?.trim?.() ?? toast?.propertyName ?? '';
		const unitFromToast = toast?.unitName?.trim?.() ?? toast?.unitName ?? '';
		if (propertyFromToast || unitFromToast) {
			if (propertyFromToast && unitFromToast) return `${propertyFromToast} - ${unitFromToast}`;
			return propertyFromToast || unitFromToast;
		}
		if (!toast?.issueId) return 'New maintenance request';
		const issue = issuesById.get(toast.issueId);
		if (!issue) return 'New maintenance request';
		const property = issue.property?.trim?.() ?? issue.property ?? '';
		const unit = issue.unit?.trim?.() ?? issue.unit ?? '';
		if (!property && !unit) return 'New maintenance request';
		if (property && unit) return `${property} - ${unit}`;
		return property || unit;
	};

	const getStableIssueLabel = (toast) => {
		const next = getIssueLabel(toast);
		const key = toast?.runId ?? toast?.run_id ?? null;
		if (!key) return next;
		if (next && next !== FALLBACK_LABEL) {
			lastLabels.set(key, next);
			return next;
		}
		return lastLabels.get(key) ?? next;
	};

	$: {
		const activeIds = new Set(($agentToasts ?? []).map((toast) => toast?.runId ?? toast?.run_id));
		for (const key of lastLabels.keys()) {
			if (!activeIds.has(key)) lastLabels.delete(key);
		}
	}
</script>

<div
	class="pointer-events-none fixed right-4 bottom-4 flex w-full max-w-xs flex-col gap-2"
	style="z-index: 2147483647;"
	aria-live="polite"
>
	{#each $agentToasts as toast (toast.runId)}
		<div
			transition:fly={{ y: 12, duration: 160 }}
			class="pointer-events-auto flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-lg"
		>
			<div class="flex min-w-0 flex-1 flex-col gap-3">
				<div class="flex items-center justify-between text-[11px] text-neutral-500">
					<span class="min-w-0 truncate">{getStableIssueLabel(toast) ?? ''}</span>
					<button
						type="button"
						class="pointer-events-auto -mr-1 inline-flex h-4 w-4 items-center justify-center text-neutral-400 transition hover:text-neutral-600"
						aria-label="Dismiss toast"
						on:click={() => agentToasts.dismissForever(toast.runId, $page.params.workspace)}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="12"
							height="12"
							fill="currentColor"
							viewBox="0 0 16 16"
						>
							<path
								d="M2.854 2.146a.5.5 0 0 1 .707 0L8 6.586l4.439-4.44a.5.5 0 1 1 .707.708L8.707 7.293l4.439 4.439a.5.5 0 0 1-.707.707L8 8l-4.439 4.439a.5.5 0 0 1-.707-.707l4.439-4.439-4.439-4.439a.5.5 0 0 1 0-.708z"
							/>
						</svg>
					</button>
				</div>
				<div class="flex items-center gap-3">
					<div class="flex h-6 w-6 items-center justify-center">
						{#if toast.stage === 'done'}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								fill="currentColor"
								class="text-emerald-600"
								viewBox="0 0 16 16"
							>
								<path
									d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"
								/>
							</svg>
						{:else}
							<span
								class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800"
							></span>
						{/if}
					</div>
					<div class="relative h-5 min-w-0 flex-1 overflow-hidden">
						{#key toast.title}
							<div
								in:fly={{ y: 6, duration: 160, delay: 260 }}
								out:fade={{ duration: 80 }}
								class="absolute inset-0 truncate text-xs font-medium text-neutral-800"
							>
								{toast.title}
							</div>
						{/key}
					</div>
				</div>
			</div>
		</div>
	{/each}
</div>
