<script>
	import { onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	const defaultEmail = 'jose@lapropertymgmt.com';
	/** @type {HTMLInputElement | null} */
	let passwordInput = null;
	let emailValue = '';
	let loading = false;
	export let form;
	/** @type {import('./$types').PageData & { returnTo?: string | null }} */
	export let data;

	$: emailValue = data.inviteEmail ?? defaultEmail;

	onMount(async () => {
		await tick();
		passwordInput?.focus();
		passwordInput?.select?.();
	});

	const handleLogin = () => {
		loading = true;
		return async (/** @type {{ update: () => Promise<void> }} */ { update }) => {
			await update();
			loading = false;
		};
	};
</script>

<div class="relative flex min-h-screen flex-col items-center justify-center bg-white px-6">
	<div
		class={`flex w-full flex-col items-center justify-center transition-opacity duration-200 ${
			loading ? 'pointer-events-none opacity-0' : 'opacity-100'
		}`}
	>
		<a
			class="anim-auth-1 font-regular mb-8 flex items-center gap-1 text-xl tracking-[0.1em] text-neutral-800 uppercase"
			style="font-family: 'Zalando Sans Expanded', sans-serif;"
			href="/">Bedrock</a
		>
		<div class="anim-auth-2 w-full max-w-xs">
			<form method="POST" action="?/login" use:enhance={handleLogin} class="flex flex-col gap-4">
				<input type="hidden" name="invite_token" value={data.inviteToken ?? ''} />
				<input type="hidden" name="return_to" value={data.returnTo ?? ''} />
				{#if form?.error}
					<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{form.error}</p>
				{/if}
				<div class="flex flex-col gap-1.5">
					<label class="text-sm text-neutral-600" for="email">Email</label>
					<input
						id="email"
						name="email"
						type="email"
						autocomplete="email"
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="jane@company.com"
						value={emailValue}
						required
					/>
				</div>
				<div class="flex flex-col gap-1.5">
					<label class="text-sm text-neutral-600" for="password">Password</label>
					<input
						id="password"
						name="password"
						type="password"
						autocomplete="current-password"
						class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
						placeholder="••••••••"
						bind:this={passwordInput}
						autofocus
						required
					/>
				</div>
				<button
					type="submit"
					class="mt-2 rounded-xl bg-stone-800 px-4 py-2.5 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
				>
					Log in
				</button>
			</form>
			<p class="anim-auth-3 mt-6 text-center text-sm text-neutral-500">
				Don't have an account? <a class="text-neutral-800 hover:underline" href="/signup"
					>Get started</a
				>
			</p>
		</div>
	</div>
	{#if loading}
		<div
			class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white px-6 text-center"
			aria-live="polite"
		>
			<div
				class="text-sm tracking-[0.2em] text-neutral-700 uppercase"
				style="font-family: 'Zalando Sans Expanded', sans-serif;"
			>
				Bedrock
			</div>
			<div class="text-sm font-medium text-neutral-500">
				<span class="thinking-sheen" data-text="Loading your workspace...">
					Loading your workspace...
				</span>
			</div>
		</div>
	{/if}
</div>

<style>
	.thinking-sheen {
		position: relative;
		display: inline-block;
		color: #9ca3af;
	}

	.thinking-sheen::after {
		content: attr(data-text);
		position: absolute;
		left: 0;
		top: 0;
		width: 100%;
		color: transparent;
		background-image: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.2) 0%,
			rgba(255, 255, 255, 0.95) 45%,
			rgba(255, 255, 255, 0.2) 90%
		);
		background-size: 200% 100%;
		background-position: 200% 50%;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: thinking-sheen 1.2s ease-in-out infinite;
	}

	@keyframes thinking-sheen {
		0% {
			background-position: 200% 50%;
		}
		100% {
			background-position: 0% 50%;
		}
	}
</style>
