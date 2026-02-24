<div class="flex min-h-screen flex-col items-center justify-center bg-white px-6">
	<a
		class="mb-8 text-xl font-regular flex items-center gap-1 tracking-[0.1em] uppercase text-neutral-800"
		style="font-family: 'Zalando Sans Expanded', sans-serif;"
		href="/"
	>Bedrock</a>
	<div class="w-full max-w-xs">
<form class="flex flex-col gap-4">
			<div class="flex flex-col gap-1.5">
				<label class="text-sm text-neutral-600" for="email">Email</label>
				<input
					id="email"
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
					type="password"
					autocomplete="current-password"
					class="rounded-xl border border-stone-300 px-3.5 py-2.5 text-sm text-neutral-800 outline-none focus:border-stone-500"
					placeholder="••••••••"
				/>
			</div>
			<button
				type="button"
				class="mt-2 rounded-xl bg-stone-800 px-4 py-2.5 text-sm text-neutral-200 transition-colors hover:bg-stone-700"
			>
				Log in
			</button>
		</form>
		<p class="mt-6 text-center text-sm text-neutral-500">
			Don't have an account? <a class="text-neutral-800 hover:underline" href="/signup">Get started</a>
		</p>
	</div>
</div>
