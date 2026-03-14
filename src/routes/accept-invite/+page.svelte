<script>
	// @ts-nocheck
	import { goto } from '$app/navigation';
	import { clearSessionCaches } from '$lib/stores/clearSessionCaches';

	export let data;

	let status = 'idle';
	let errorMsg = '';

	$: inviteEmail = data.inviteEmail ?? null;
	$: userEmail = data.user?.email ?? null;
	$: requiresLogout =
		!!data.user && !!inviteEmail && userEmail?.toLowerCase() !== inviteEmail.toLowerCase();
	$: inviterName = data.inviteMeta?.inviterName ?? 'Someone';
	$: workspaceName = data.inviteMeta?.workspaceName ?? 'this workspace';
	$: role = data.inviteMeta?.role ?? 'member';
	$: roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Member';

	const acceptInvite = async () => {
		if (!data.user || requiresLogout) return;
		status = 'accepting';
		errorMsg = '';
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
			goto(json.workspace_slug ? `/${json.workspace_slug}` : '/');
		} catch {
			status = 'error';
			errorMsg = 'Something went wrong. Please try again.';
		}
	};
</script>

<div class="min-h-screen bg-white px-6">
	<div class="flex items-center justify-between py-8 text-sm text-neutral-500">
		<a class="flex items-center gap-2 text-neutral-600 hover:text-neutral-800" href="/">
			<span aria-hidden="true">←</span>
			<span>Back to Bedrock</span>
		</a>
		{#if data.user}
			<div class="text-right">
				<p class="text-xs tracking-[0.2em] text-neutral-400 uppercase">Logged in as</p>
				<p class="text-sm font-medium text-neutral-700">{userEmail}</p>
			</div>
		{/if}
	</div>

	<div class="flex items-center justify-center pb-16">
		<div
			class="w-full max-w-md rounded-3xl border border-neutral-200 bg-white px-8 py-10 text-center shadow-[0_20px_60px_-40px_rgba(0,0,0,0.6)]"
		>
			<div
				class="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-stone-100 text-xl"
			>
				<span aria-hidden="true">◆</span>
			</div>
			{#if !data.inviteValid}
				<h1 class="mb-2 text-2xl font-medium text-neutral-800">Invite unavailable</h1>
				<p class="mb-6 text-sm text-neutral-500">This invite link is invalid or has expired.</p>
				<a href="/" class="rounded-xl bg-stone-800 px-5 py-2.5 text-sm text-neutral-200"
					>Go to Bedrock</a
				>
			{:else}
				<h1 class="mb-3 text-2xl font-medium text-neutral-800">
					{inviterName} invited you to the {workspaceName} workspace
				</h1>
				<p class="mb-8 text-sm text-neutral-500">You'll join as a {roleLabel}.</p>
				{#if requiresLogout}
					<p class="mb-6 text-sm text-neutral-500">
						You're logged in as {userEmail}. This invite is for {inviteEmail}. Log out to switch
						accounts and accept it.
					</p>
					<form
						method="POST"
						action={`/api/logout?redirect=${encodeURIComponent(`/accept-invite?token=${data.token}`)}`}
						class="flex justify-center"
						on:submit={clearSessionCaches}
					>
						<button
							type="submit"
							class="w-full rounded-xl bg-stone-800 px-5 py-3 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
						>
							Log out to accept invite
						</button>
					</form>
				{:else}
					{#if status === 'error'}
						<p class="mb-4 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">
							{errorMsg}
						</p>
					{/if}
					{#if data.user}
						<button
							type="button"
							on:click={acceptInvite}
							class="w-full rounded-xl bg-stone-800 px-5 py-3 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
							disabled={status === 'accepting'}
						>
							{status === 'accepting' ? 'Accepting…' : 'Accept invite'}
						</button>
						{#if status === 'success'}
							<p class="mt-4 text-sm text-neutral-500">Invite accepted! Redirecting…</p>
						{/if}
					{:else}
						<a
							href="/signup?invite={data.token}"
							class="block w-full rounded-xl bg-stone-800 px-5 py-3 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
						>
							Accept invite
						</a>
						<p class="mt-4 text-sm text-neutral-500">
							Already have an account?
							<a class="ml-1 text-neutral-800 hover:underline" href="/login?invite={data.token}">
								Log in
							</a>
						</p>
					{/if}
				{/if}
			{/if}
		</div>
	</div>
</div>
