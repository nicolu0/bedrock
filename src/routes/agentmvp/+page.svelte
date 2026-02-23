<script>
	import IssueDashboard from '$lib/components/IssueDashboard.svelte';

	export let data;
	const {
		user,
		gmailUser,
		realtimeAccessToken,
		issues,
		threadsByIssue,
		messagesByThread,
		connections,
		buildings,
		vendors,
		units,
		tenants,
		actions
	} = data;
</script>

{#if !user}
	<div class="flex min-h-screen items-center justify-center bg-white px-6">
		<div class="w-full max-w-md rounded-3xl border border-neutral-200 bg-white p-8 shadow-sm">
			<form class="space-y-4" method="POST" action="?/signIn">
				<div>
					<label class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Email</label>
					<input
						type="email"
						class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
						name="email"
						required
					/>
				</div>
				<div>
					<label class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Password</label>
					<input
						type="password"
						class="mt-2 w-full rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
						name="password"
						required
					/>
				</div>
				{#if data?.form?.error}
					<div class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">
						{data.form.error}
					</div>
				{/if}
				<button
					type="submit"
					class="flex w-full items-center justify-center rounded-lg bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800"
				>
					Continue
				</button>
			</form>
		</div>
	</div>
{:else}
	<IssueDashboard
		{issues}
		{threadsByIssue}
		{messagesByThread}
		{gmailUser}
		{connections}
		{buildings}
		{vendors}
		{units}
		{tenants}
		{actions}
		{realtimeAccessToken}
		connectHref="/agentmvp/gmail/connect"
	/>
{/if}
