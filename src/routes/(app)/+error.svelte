<script>
	import { page } from '$app/stores';
</script>

<div class="min-h-screen bg-white font-sans text-neutral-900" style="font-family: inherit;">
	<div class="px-6 pt-6">
		<a
			href="/"
			class="inline-flex items-center gap-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-800"
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
				<path fill-rule="evenodd" d="M15 8a.5.5 0 0 0-.5-.5H2.707l3.147-3.146a.5.5 0 1 0-.708-.708l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L2.707 8.5H14.5A.5.5 0 0 0 15 8"/>
			</svg>
			Back to your workspace
		</a>
	</div>
	<div class="flex min-h-[calc(100vh-56px)] items-center justify-center">
		<p class="text-sm text-neutral-500">{$page.error?.message ?? 'Something went wrong.'}</p>
	</div>
</div>
