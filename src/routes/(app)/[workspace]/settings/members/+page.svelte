<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold text-neutral-900">Members</h1>
			<p class="text-sm text-neutral-500">Manage who has access to this workspace.</p>
		</div>
		<div class="flex items-center gap-2">
			<button
				class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-700"
			>
				Export CSV
			</button>
			<button class="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white">Invite</button>
		</div>
	</div>
	<div class="flex items-center gap-3">
		<div
			class="flex w-80 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2"
		>
			<span class="text-neutral-400">🔍</span>
			<input
				class="w-full border-0 bg-transparent text-sm text-neutral-700 outline-none"
				placeholder="Search by name or email"
			/>
		</div>
		<button
			class="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700"
		>
			All
		</button>
	</div>
	<div class="overflow-hidden rounded-xl border border-neutral-200 bg-white">
		<div
			class="grid grid-cols-[2fr_2fr_1fr_1fr_1fr] gap-4 border-b border-neutral-200 bg-neutral-50 px-5 py-3 text-xs font-semibold tracking-[0.12em] text-neutral-500 uppercase"
		>
			<div>Name</div>
			<div>Email</div>
			<div>Status</div>
			<div>Role</div>
			<div>Joined</div>
		</div>
		<div class="px-5 py-4 text-sm text-neutral-600">No members yet.</div>
	</div>
</div>
