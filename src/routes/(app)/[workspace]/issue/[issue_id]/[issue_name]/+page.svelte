<script>
	// @ts-nocheck
	import { page } from '$app/stores';

	$: issueId = $page.params.issue_id ?? 'HUB-1';
	$: issueNameSlug = $page.params.issue_name ?? 'issues-page-layout';
	$: issueName = issueNameSlug
		? issueNameSlug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
		: 'Issues Page Layout';
	const statusLabel = 'In Progress';
</script>

<div class="flex h-full">
	<div class="flex min-w-0 flex-1 flex-col">
		<div
			class="flex items-center justify-between border-b border-neutral-100 px-6 py-2 text-sm text-neutral-600"
		>
			<div class="flex items-center gap-2">
				<span class="text-neutral-700">My issues</span>
				<span class="text-neutral-300">›</span>
				<span class="h-3 w-3 rounded-full border border-amber-500"></span>
				<span class="text-neutral-700">{issueId}</span>
				<span class="text-neutral-500">{issueName}</span>
			</div>
		</div>

		<div class="flex-1 px-10 py-8">
			<h1 class="text-2xl font-semibold text-neutral-900">{issueName}</h1>
			<div class="mt-2 text-sm text-neutral-500">Add description...</div>
			<div class="mt-6 flex items-center gap-3 text-sm text-neutral-600">
				<button
					class="inline-flex items-center gap-2 rounded-md px-2 py-1 transition hover:bg-neutral-100"
					type="button"
				>
					<span class="text-neutral-400">+</span>
					Add sub-issues
				</button>
				<div class="ml-auto text-neutral-400">@</div>
			</div>

			<div class="mt-8 border-t border-neutral-200 pt-6">
				<div class="flex items-center justify-between">
					<h2 class="text-base font-semibold text-neutral-800">Activity</h2>
					<div class="text-sm text-neutral-400">Unsubscribe</div>
				</div>
				<div class="mt-4 space-y-4 text-sm text-neutral-600">
					<div class="flex items-center gap-3">
						<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
						<span>Andrew Chang created the issue · 54min ago</span>
					</div>
					<div class="flex items-center gap-3">
						<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
						<span>Andrew Chang changed project from Vanessa to Issues · 36min ago</span>
					</div>
				</div>

				<div class="mt-6 space-y-4">
					<div class="rounded-xl border border-neutral-200 bg-white">
						<div class="flex items-center gap-3 px-4 pt-4 text-sm text-neutral-700">
							<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
							<div class="font-medium">Andrew Chang</div>
							<div class="text-neutral-400">18min ago</div>
						</div>
						<div class="mt-3 px-4 text-sm text-neutral-800">Copying linear</div>
						<div class="mt-4 border-t border-neutral-200 px-4 py-3">
							<div class="flex items-center justify-between text-sm text-neutral-400">
								<div class="flex items-center gap-3">
									<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
									<span>Leave a reply...</span>
								</div>
								<div class="flex items-center gap-3">
									<span
										class="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 text-neutral-500"
									>
										↑
									</span>
								</div>
							</div>
						</div>
					</div>
					<div class="rounded-xl border border-neutral-200 bg-white">
						<div class="flex items-center gap-3 px-4 pt-4 text-sm text-neutral-700">
							<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
							<div class="font-medium">Andrew Chang</div>
							<div class="text-neutral-400">18min ago</div>
						</div>
						<div class="mt-3 px-4 text-sm text-neutral-800">Test</div>
						<div class="mt-4 border-t border-neutral-200 px-4 py-3">
							<div class="flex items-center justify-between text-sm text-neutral-400">
								<div class="flex items-center gap-3">
									<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
									<span>Leave a reply...</span>
								</div>
								<div class="flex items-center gap-3">
									<span
										class="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 text-neutral-500"
									>
										↑
									</span>
								</div>
							</div>
						</div>
					</div>
					<div
						class="rounded-xl border border-neutral-200 bg-white px-4 py-4 text-sm text-neutral-400"
					>
						<div>Leave a comment...</div>
						<div class="mt-6 flex items-center justify-between">
							<div class="flex items-center gap-3">
								<div class="h-6 w-6 rounded-full bg-neutral-200"></div>
								<span>Leave a reply...</span>
							</div>
							<div class="flex items-center gap-3">
								<span
									class="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 text-neutral-500"
								>
									↑
								</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>

	<aside class="flex w-1/5 border-l border-neutral-200">
		<div class="flex w-full flex-col px-6 py-2">
			<div class="space-y-4 text-sm text-neutral-600">
				<div class="flex items-center gap-2">
					<div class="h-4 w-4 rounded-full bg-neutral-200"></div>
					<span>Andrew Chang</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="h-3 w-3 rounded-full border border-amber-500"></span>
					<span>{statusLabel}</span>
				</div>
			</div>
		</div>
	</aside>
</div>
