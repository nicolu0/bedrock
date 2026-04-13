<script>
	// @ts-nocheck
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import {
		gmailConnectionCache,
		primeGmailConnectionCache
	} from '$lib/stores/gmailConnectionCache.js';

	export let data;

	$: connection = $gmailConnectionCache;

	const APPFOLIO_KEY = 'appfolio_enabled';
	let appfolioEnabled = false;
	let policyLearningEnabled = false;
	let policyLearningSaving = false;
	let policyLearningError = '';

	$: isAdmin = (data?.role ?? '').toLowerCase() === 'admin';
	$: if (browser && !policyLearningSaving) {
		policyLearningEnabled = Boolean(data?.workspace?.policy_learning_enabled);
	}

	const syncAppfolioEnabled = () => {
		if (!browser) return;
		appfolioEnabled = window.localStorage.getItem(APPFOLIO_KEY) === 'true';
	};

	const toggleAppfolio = () => {
		appfolioEnabled = !appfolioEnabled;
		window.localStorage.setItem(APPFOLIO_KEY, appfolioEnabled ? 'true' : 'false');
	};

	const togglePolicyLearning = async () => {
		if (!isAdmin) return;
		if (policyLearningSaving) return;
		policyLearningError = '';
		const prev = policyLearningEnabled;
		const next = !prev;
		policyLearningEnabled = next;
		policyLearningSaving = true;
		try {
			const res = await fetch('/api/workspaces/policy-learning', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspace_id: data?.workspace?.id, enabled: next })
			});
			const payload = await res.json().catch(() => null);
			if (!res.ok) {
				throw new Error(payload?.error ?? `HTTP ${res.status}`);
			}
			await invalidate('app:workspace');
		} catch (e) {
			policyLearningEnabled = prev;
			policyLearningError = e?.message ?? 'Unable to update setting.';
		} finally {
			policyLearningSaving = false;
		}
	};

	$: if (browser && data.gmailConnection) {
		data.gmailConnection.then((c) => {
			primeGmailConnectionCache(c);
		});
	}

	onMount(() => {
		syncAppfolioEnabled();
		const handleStorage = (event) => {
			if (event.key === APPFOLIO_KEY) {
				syncAppfolioEnabled();
			}
		};
		window.addEventListener('storage', handleStorage);
		return () => window.removeEventListener('storage', handleStorage);
	});

	const formatDate = (value) => {
		if (!value) return 'Unknown';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return 'Unknown';
		return date.toLocaleString();
	};
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-semibold text-neutral-900">Integrations</h1>
		<p class="text-sm text-neutral-500">Connect your inboxes and external services.</p>
	</div>

	<section class="rounded-2xl border border-neutral-200 bg-white p-6">
		{#if connection === undefined}
			<div class="h-10 w-48 animate-pulse rounded bg-neutral-100"></div>
		{:else}
			<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div>
					<div class="flex items-center gap-3">
						<div class="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-50">
							<svg
								class="h-[26px] w-[26px]"
								viewBox="0 0 32 32"
								fill="none"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path
									d="M2 11.9556C2 8.47078 2 6.7284 2.67818 5.39739C3.27473 4.22661 4.22661 3.27473 5.39739 2.67818C6.7284 2 8.47078 2 11.9556 2H20.0444C23.5292 2 25.2716 2 26.6026 2.67818C27.7734 3.27473 28.7253 4.22661 29.3218 5.39739C30 6.7284 30 8.47078 30 11.9556V20.0444C30 23.5292 30 25.2716 29.3218 26.6026C28.7253 27.7734 27.7734 28.7253 26.6026 29.3218C25.2716 30 23.5292 30 20.0444 30H11.9556C8.47078 30 6.7284 30 5.39739 29.3218C4.22661 28.7253 3.27473 27.7734 2.67818 26.6026C2 25.2716 2 23.5292 2 20.0444V11.9556Z"
									fill="white"
								/>
								<path
									d="M22.0515 8.52295L16.0644 13.1954L9.94043 8.52295V8.52421L9.94783 8.53053V15.0732L15.9954 19.8466L22.0515 15.2575V8.52295Z"
									fill="#EA4335"
								/>
								<path
									d="M23.6231 7.38639L22.0508 8.52292V15.2575L26.9983 11.459V9.17074C26.9983 9.17074 26.3978 5.90258 23.6231 7.38639Z"
									fill="#FBBC05"
								/>
								<path
									d="M22.0508 15.2575V23.9924H25.8428C25.8428 23.9924 26.9219 23.8813 26.9995 22.6513V11.459L22.0508 15.2575Z"
									fill="#34A853"
								/>
								<path
									d="M9.94811 24.0001V15.0732L9.94043 15.0669L9.94811 24.0001Z"
									fill="#C5221F"
								/>
								<path
									d="M9.94014 8.52404L8.37646 7.39382C5.60179 5.91001 5 9.17692 5 9.17692V11.4651L9.94014 15.0667V8.52404Z"
									fill="#C5221F"
								/>
								<path
									d="M9.94043 8.52441V15.0671L9.94811 15.0734V8.53073L9.94043 8.52441Z"
									fill="#C5221F"
								/>
								<path
									d="M5 11.4668V22.6591C5.07646 23.8904 6.15673 24.0003 6.15673 24.0003H9.94877L9.94014 15.0671L5 11.4668Z"
									fill="#4285F4"
								/>
							</svg>
						</div>
						<div>
							<h2 class="text-lg font-semibold text-neutral-900">Gmail</h2>
							<p class="text-sm text-neutral-500">Receive and send maintenance messages.</p>
						</div>
					</div>
					<div class="mt-4 text-sm text-neutral-600 md:mt-3">
						<div class="flex items-center gap-2">
							<span
								class={`h-2.5 w-2.5 rounded-full ${connection?.id ? 'bg-emerald-500' : 'bg-neutral-300'}`}
							></span>
							<span>{connection?.id ? 'Connected' : 'Not connected'}</span>
						</div>
						<div class="mt-1 text-xs text-neutral-400">
							{connection?.email ?? 'Not connected'}
							{#if connection?.expires_at}
								<span class="ml-2">Expires {formatDate(connection.expires_at)}</span>
							{/if}
						</div>
					</div>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<a
						href={`/${data.workspace.slug}/settings/integrations/gmail/connect`}
						class="inline-flex items-center justify-center rounded-xl bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800"
					>
						{connection?.id ? 'Reconnect Gmail' : 'Connect Gmail'}
					</a>
					{#if connection?.id}
						<form
							method="POST"
							action={`/${data.workspace.slug}/settings/integrations/gmail/disconnect`}
						>
							<button
								type="submit"
								class="inline-flex items-center justify-center rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 transition hover:border-neutral-300 hover:bg-neutral-50"
							>
								Disconnect Gmail
							</button>
						</form>
					{/if}
				</div>
			</div>
			<div class="mt-6 border-t border-neutral-100 pt-4">
				<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<h3 class="text-sm font-semibold text-neutral-900">Appfolio</h3>
						<p class="text-xs text-neutral-500">Use Appfolio approvals instead of Gmail send.</p>
					</div>
					<button
						type="button"
						class={`inline-flex h-7 w-12 items-center rounded-full border transition ${
							appfolioEnabled
								? 'border-emerald-500 bg-emerald-500'
								: 'border-neutral-300 bg-neutral-200'
						}`}
						on:click={toggleAppfolio}
						aria-pressed={appfolioEnabled}
						aria-label="Toggle Appfolio drafts"
					>
						<span
							class={`h-5 w-5 rounded-full bg-white shadow transition ${
								appfolioEnabled ? 'translate-x-6' : 'translate-x-1'
							}`}
						></span>
					</button>
				</div>
				<div class="mt-4 border-t border-neutral-100 pt-4">
					<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div>
							<h3 class="text-sm font-semibold text-neutral-900">Policy learning</h3>
							<p class="text-xs text-neutral-500">
								Show the tone and automation prompts when sending/approving drafts. Applies to
								everyone in this workspace.
							</p>
						</div>
						<button
							type="button"
							disabled={!isAdmin || policyLearningSaving}
							class={`inline-flex h-7 w-12 items-center rounded-full border transition disabled:opacity-50 ${
								policyLearningEnabled
									? 'border-emerald-500 bg-emerald-500'
									: 'border-neutral-300 bg-neutral-200'
							}`}
							on:click={togglePolicyLearning}
							aria-pressed={policyLearningEnabled}
							aria-label="Toggle policy learning"
						>
							<span
								class={`h-5 w-5 rounded-full bg-white shadow transition ${
									policyLearningEnabled ? 'translate-x-6' : 'translate-x-1'
								}`}
							></span>
						</button>
					</div>
					{#if !isAdmin}
						<div class="mt-2 text-xs text-neutral-400">Only admins can change this.</div>
					{/if}
					{#if policyLearningError}
						<div class="mt-2 text-xs text-red-500">{policyLearningError}</div>
					{/if}
				</div>
			</div>
		{/if}
	</section>
</div>
