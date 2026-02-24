<script>
	// @ts-nocheck
	export let data;
</script>

<div class="flex min-h-screen flex-col items-center justify-center bg-white px-6">
	<a
		class="font-regular mb-8 flex items-center gap-1 text-xl tracking-[0.1em] text-neutral-800 uppercase"
		style="font-family: 'Zalando Sans Expanded', sans-serif;"
		href="/">Bedrock</a
	>
	<div class="w-full max-w-xs">
		<form class="flex flex-col gap-4" method="POST" action="?/signIn">
			<div class="flex flex-col gap-1.5">
				<label class="text-sm text-neutral-600" for="email">Email</label>
				<input
					id="email"
					type="email"
					autocomplete="email"
					class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
					placeholder="jane@company.com"
					name="email"
					required
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<label class="text-sm text-neutral-600" for="password">Password</label>
				<input
					id="password"
					type="password"
					autocomplete="current-password"
					class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
					placeholder="••••••••"
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
				class="mt-2 rounded-xl bg-stone-800 px-4 py-2.5 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
			>
				Log in
			</button>
		</form>
		<p class="mt-6 text-center text-sm text-neutral-500">
			Don't have an account? <a class="text-neutral-800 hover:underline" href="/signup"
				>Get started</a
			>
		</p>
	</div>
</div>
