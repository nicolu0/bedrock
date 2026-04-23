<script>
	// @ts-nocheck
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	export let data;
	export let form;

	const DEFAULT_SETTINGS = {
		chatGuid: '',
		bedrockHandles: [],
		coordinatorLabel: 'Jose',
		apiKeys: []
	};

	$: settings = data?.coordinatorSettings ?? DEFAULT_SETTINGS;

	const initial = data?.coordinatorSettings ?? DEFAULT_SETTINGS;
	let chatGuid = initial.chatGuid ?? '';
	let handlesText = (initial.bedrockHandles ?? []).join(', ');
	let coordinatorLabel = initial.coordinatorLabel ?? 'Jose';
	let newKeyName = 'My Mac';
	let savedToast = false;

	$: if (form?.newKey) {
		// keep showing until user dismisses
	}

	function formatDate(iso) {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	function onSaved() {
		savedToast = true;
		setTimeout(() => (savedToast = false), 2000);
	}
</script>

<div class="max-w-3xl space-y-8">
	<div>
		<h1 class="text-2xl font-semibold text-neutral-900">Coordinator iMessage</h1>
		<p class="mt-1 text-sm text-neutral-500">
			Sync messages from a single iMessage group chat on your Mac into Bedrock.
			Messages get auto-linked to open issues when possible.
		</p>
	</div>

	<section class="space-y-3 rounded-xl border border-neutral-200 bg-white p-6">
		<div>
			<h2 class="text-base font-medium text-neutral-900">Group chat config</h2>
			<p class="mt-1 text-sm text-neutral-500">
				The install script lists your recent group chats and helps you pick the right
				<code class="rounded bg-neutral-100 px-1 text-[12px]">chat.guid</code>.
			</p>
		</div>

		<form
			method="POST"
			action="?/save"
			class="space-y-3"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
					onSaved();
				};
			}}
		>
			<label class="block space-y-1">
				<span class="text-sm font-medium text-neutral-800">chat.guid</span>
				<input
					name="chat_guid"
					bind:value={chatGuid}
					placeholder="iMessage;+;chat123456789abcdef"
					class="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
				/>
			</label>

			<label class="block space-y-1">
				<span class="text-sm font-medium text-neutral-800">
					"Bedrock" handles (founder + cofounder)
				</span>
				<span class="block text-xs text-neutral-500">
					Comma-separated phone numbers or emails. Messages from these senders are labeled
					"Bedrock" on the issue timeline.
				</span>
				<textarea
					name="bedrock_handles"
					bind:value={handlesText}
					rows="2"
					placeholder="+14155551111, +14155552222"
					class="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
				></textarea>
			</label>

			<label class="block space-y-1">
				<span class="text-sm font-medium text-neutral-800">Coordinator label</span>
				<span class="block text-xs text-neutral-500">
					What to call anyone else in the chat. Defaults to "Jose".
				</span>
				<input
					name="coordinator_label"
					bind:value={coordinatorLabel}
					class="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
				/>
			</label>

			<div class="flex items-center gap-3">
				<button
					type="submit"
					class="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800"
				>
					Save
				</button>
				{#if savedToast}
					<span class="text-sm text-emerald-600">Saved</span>
				{/if}
			</div>
		</form>
	</section>

	<section class="space-y-4 rounded-xl border border-neutral-200 bg-white p-6">
		<div>
			<h2 class="text-base font-medium text-neutral-900">API keys</h2>
			<p class="mt-1 text-sm text-neutral-500">
				The Mac sync script authenticates with a workspace API key. Generate one here and copy it into
				<code class="rounded bg-neutral-100 px-1 text-[12px]">~/.bedrock-imessage/config.json</code>.
			</p>
		</div>

		<form
			method="POST"
			action="?/generateKey"
			class="flex gap-2"
			use:enhance={() => async ({ update }) => { await update(); }}
		>
			<input
				name="name"
				bind:value={newKeyName}
				placeholder="Key label (e.g. My Mac)"
				class="flex-1 rounded-md border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
			/>
			<button
				type="submit"
				class="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
			>
				Generate key
			</button>
		</form>

		{#if form?.newKey}
			<div class="rounded-md border border-amber-200 bg-amber-50 p-3">
				<div class="text-sm font-medium text-amber-900">
					Copy this key now — you won't be able to see it again.
				</div>
				<code class="mt-2 block break-all rounded bg-white px-2 py-1 text-xs text-neutral-900">
					{form.newKey}
				</code>
			</div>
		{/if}

		<div class="divide-y divide-neutral-100">
			{#each settings.apiKeys as k (k.id)}
				<div class="flex items-center justify-between py-2">
					<div class="min-w-0 flex-1">
						<div class="text-sm text-neutral-900">{k.name}</div>
						<div class="text-xs text-neutral-500">
							{k.key_prefix}… · created {formatDate(k.created_at)} · last used {formatDate(k.last_used_at)}
						</div>
					</div>
					<form method="POST" action="?/revokeKey" use:enhance={() => async ({ update }) => { await update(); await invalidateAll(); }}>
						<input type="hidden" name="id" value={k.id} />
						<button
							type="submit"
							class="text-xs text-red-600 hover:text-red-700"
						>
							Revoke
						</button>
					</form>
				</div>
			{:else}
				<div class="py-2 text-sm text-neutral-500">No API keys yet.</div>
			{/each}
		</div>
	</section>

	<section class="space-y-3 rounded-xl border border-neutral-200 bg-white p-6">
		<h2 class="text-base font-medium text-neutral-900">Install on your Mac</h2>
		<p class="text-sm text-neutral-500">
			After generating an API key above, run on your Mac:
		</p>
		<pre class="overflow-x-auto rounded bg-neutral-900 px-3 py-2 text-xs text-neutral-100"><code
				>cd ~/dev/bedrock/scripts/imessage-sync
./install.sh</code></pre>
		<p class="text-xs text-neutral-500">
			The installer prompts for your workspace ID, API key, and walks you through picking the
			right group chat. It then installs a launchd agent that syncs every 2 minutes.
			If you see <code class="text-neutral-700">authorization denied</code>, grant Full Disk Access to
			your <code class="text-neutral-700">node</code> binary in System Settings.
		</p>
	</section>
</div>
