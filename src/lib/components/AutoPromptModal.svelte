<script>
	// @ts-nocheck
	import { fade, scale } from 'svelte/transition';

	export let show = false;
	export let title = 'Automatically reply to similar issues?';
	export let template = '';
	export let errorMessage = '';
	export let onClose = null;
	export let onSecondary = null;
	export let onPrimary = null;
	export let secondaryLabel = 'Require Approval';
	export let primaryLabel = 'Automate';
	export let isLoading = false;
	export let secondaryDisabled = false;
	export let primaryDisabled = false;

	const handleClose = () => {
		onClose?.();
	};

	const handleSecondary = () => {
		onSecondary?.();
	};

	const handlePrimary = () => {
		onPrimary?.();
	};
</script>

{#if show}
	<div
		class="fixed inset-0 z-40 hidden bg-neutral-900/30 md:block"
		on:click={handleClose}
		transition:fade={{ duration: 160 }}
	></div>
	<div
		class="fixed inset-0 z-50 flex items-center justify-center p-0 md:px-4"
		on:click={handleClose}
	>
		<div
			class="flex h-full w-full flex-col border border-neutral-200 bg-white shadow-xl md:h-auto md:max-h-[85vh] md:max-w-3xl md:rounded-lg"
			role="dialog"
			aria-modal="true"
			on:click|stopPropagation
			transition:scale={{ duration: 180, start: 0.96 }}
		>
			<div class="flex items-center justify-between px-5 py-4">
				<div>
					<div class="text-base font-semibold text-neutral-900">{title}</div>
				</div>
				<button
					type="button"
					class="-mr-1 rounded-lg p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-stone-400 focus-visible:outline-none"
					on:click={handleClose}
					disabled={isLoading}
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
			<div
				class="flex-1 overflow-auto px-5 pt-2 pb-24 md:pb-4"
				style="padding-bottom: calc(6rem + env(safe-area-inset-bottom));"
			>
				<p class="text-sm text-neutral-600">
					Bedrock can automatically reply with a message guideline for similar issues that occur.
				</p>
				<div class="mt-3">
					<div
						class="max-h-80 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm whitespace-pre-wrap text-neutral-700"
					>
						{template}
					</div>
				</div>
				{#if errorMessage}
					<div class="mt-2 text-xs text-rose-600">{errorMessage}</div>
				{/if}
			</div>
			<div class="hidden items-center justify-end gap-2 px-5 py-4 md:flex">
				<button
					type="button"
					class="rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 transition hover:border-neutral-300"
					on:click={handleSecondary}
					disabled={secondaryDisabled}
				>
					{secondaryLabel}
				</button>
				<button
					type="button"
					class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white transition hover:bg-neutral-800 disabled:opacity-60"
					on:click={handlePrimary}
					disabled={primaryDisabled}
				>
					{#if isLoading}
						Saving...
					{:else}
						{primaryLabel}
					{/if}
				</button>
			</div>
			<div
				class="fixed right-4 bottom-4 flex items-center gap-2 md:hidden"
				style="bottom: calc(1rem + env(safe-area-inset-bottom)); right: calc(1rem + env(safe-area-inset-right));"
			>
				<button
					type="button"
					class="rounded-full border border-neutral-200 bg-white px-4 py-2 text-xs font-semibold text-neutral-700 shadow-md transition hover:border-neutral-300"
					on:click={handleSecondary}
					disabled={secondaryDisabled}
				>
					{secondaryLabel}
				</button>
				<button
					type="button"
					class="rounded-full bg-neutral-900 px-4 py-2 text-xs font-semibold text-white shadow-md transition hover:bg-neutral-800 disabled:opacity-60"
					on:click={handlePrimary}
					disabled={primaryDisabled}
				>
					{#if isLoading}
						Saving...
					{:else}
						{primaryLabel}
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
