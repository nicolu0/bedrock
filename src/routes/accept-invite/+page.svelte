<script>
	// @ts-nocheck
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	export let data;

	let status = 'pending';
	let errorMsg = '';

	$: inviteEmail = data.inviteEmail ?? null;
	$: userEmail = data.user?.email ?? null;
	$: requiresLogout =
		!!data.user && !!inviteEmail && userEmail?.toLowerCase() !== inviteEmail.toLowerCase();

	onMount(async () => {
		if (!data.user || requiresLogout) return;

		status = 'accepting';
		try {
			const res = await fetch('/api/accept-invite', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: data.token })
			});
			const json = await res.json();
			if (!res.ok) {
				status = 'error';
				errorMsg = json.error ?? 'Failed to accept invite.';
				return;
			}
			status = 'success';
			goto('/');
		} catch {
			status = 'error';
			errorMsg = 'Something went wrong. Please try again.';
		}
	});
</script>

<div class="flex min-h-screen flex-col items-center justify-center bg-white px-6">
	<a
		class="font-regular mb-8 flex items-center gap-1 text-xl tracking-[0.1em] text-neutral-800 uppercase"
		style="font-family: 'Zalando Sans Expanded', sans-serif;"
		href="/">Bedrock</a
	>

	<div class="w-full max-w-xs text-center">
		{#if !data.user}
			<h1 class="mb-2 text-lg font-medium text-neutral-800">You've been invited</h1>
			<p class="mb-6 text-sm text-neutral-500">
				Create an account or log in to accept your invite.
			</p>
			<div class="flex flex-col gap-3">
				<a
					href="/signup?invite={data.token}"
					class="rounded-xl bg-stone-800 px-4 py-2.5 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
				>
					Create account
				</a>
				<a
					href="/login?invite={data.token}"
					class="rounded-xl border border-stone-300 px-4 py-2.5 text-sm text-neutral-700 transition-colors hover:bg-stone-50"
				>
					Log in
				</a>
			</div>
		{:else if requiresLogout}
			<p class="text-sm text-neutral-500">You're already signed in.</p>
		{:else if status === 'pending' || status === 'accepting'}
			<p class="text-sm text-neutral-500">Accepting your invite…</p>
		{:else if status === 'success'}
			<p class="text-sm text-neutral-500">Invite accepted! Redirecting…</p>
		{:else if status === 'error'}
			<p class="mb-4 text-sm font-medium text-red-600">{errorMsg}</p>
			<a href="/" class="text-sm text-neutral-800 hover:underline">Go to app</a>
		{/if}
	</div>
</div>

{#if requiresLogout}
	<div class="fixed inset-0 z-40 bg-neutral-900/30"></div>
	<div class="fixed inset-0 z-50 flex items-center justify-center px-4">
		<div class="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl">
			<h2 class="text-lg font-medium text-neutral-800">You're already logged in</h2>
			<p class="mt-2 text-sm text-neutral-600">
				You're signed in as {userEmail}. To accept this invite for {inviteEmail}, we need to log you
				out so you can create a new account.
			</p>
			<form
				method="POST"
				action={`/api/logout?redirect=${encodeURIComponent(`/signup?invite=${data.token}`)}`}
				class="mt-5 flex justify-end"
			>
				<button
					type="submit"
					class="rounded-xl bg-stone-800 px-4 py-2.5 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
				>
					Log out to accept invite
				</button>
			</form>
		</div>
	</div>
{/if}
