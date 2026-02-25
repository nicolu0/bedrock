<script>
	import { enhance } from '$app/forms';
	export let form;
	export let data;
</script>

<div class="flex min-h-screen flex-col items-center justify-center bg-white px-6">
	<a
		class="anim-auth-1 mb-8 text-xl font-regular flex items-center gap-1 tracking-[0.1em] uppercase text-neutral-800"
		style="font-family: 'Zalando Sans Expanded', sans-serif;"
		href="/"
	>Bedrock</a>
	<div class="anim-auth-2 w-full max-w-xs">
		<form method="POST" action="?/signup" use:enhance class="flex flex-col gap-4">
			<input type="hidden" name="invite_token" value={data.inviteToken ?? ''} />
			{#if form?.error}
				<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{form.error}</p>
			{/if}
			<div class="flex flex-col gap-1.5">
				<label class="text-sm text-neutral-600" for="name">Full name</label>
				<input
					id="name"
					name="name"
					type="text"
					autocomplete="name"
					class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
					placeholder="Jane Smith"
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<label class="text-sm text-neutral-600" for="email">Work email</label>
				<input
					id="email"
					name="email"
					type="email"
					autocomplete="email"
					class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
					placeholder="jane@company.com"
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<label class="text-sm text-neutral-600" for="password">Password</label>
				<input
					id="password"
					name="password"
					type="password"
					autocomplete="new-password"
					class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
					placeholder="••••••••"
				/>
			</div>
			<button
				type="submit"
				class="mt-2 rounded-xl bg-stone-800 px-4 py-2.5 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
			>
				Get started
			</button>
		</form>
		<p class="anim-auth-3 mt-6 text-center text-sm text-neutral-500">
			Already have an account? <a class="text-neutral-800 hover:underline" href="/login">Log in</a>
		</p>
	</div>
</div>
