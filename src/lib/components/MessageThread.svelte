<script>
	// @ts-nocheck

	import ChatIssueRow from '$lib/components/ChatIssueRow.svelte';
	import { issuesCache } from '$lib/stores/issuesCache';

	export let messages = [];
	export let tenant = { name: 'Tenant', email: '' };

	const ISSUE_MARKER_REGEX = /\[\[issue:(\{[\s\S]*?\})\]\]/g;
	const ISSUE_REF_REGEX = /\[\[issue_ref:([a-zA-Z0-9-]+)\]\]/g;

	$: issueMap = new Map(($issuesCache?.data?.issues ?? []).map((item) => [item.id, item]));
	$: if ($issuesCache?.data?.issues?.length) {
		for (const item of $issuesCache.data.issues) {
			if (item.readableId) issueMap.set(item.readableId, item);
		}
	}

	const parseSegments = (text = '') => {
		const segments = [];
		let lastIndex = 0;
		const combinedRegex = new RegExp(`${ISSUE_MARKER_REGEX.source}|${ISSUE_REF_REGEX.source}`, 'g');
		const matches = text.matchAll(combinedRegex);
		for (const match of matches) {
			const start = match.index ?? 0;
			const end = start + match[0].length;
			const before = text.slice(lastIndex, start);
			if (before.trim() && !/^[\s,\.-]+$/.test(before)) {
				segments.push({ type: 'text', value: before });
			}
			if (match[1]) {
				let issue = null;
				try {
					issue = JSON.parse(match[1]);
				} catch {
					issue = null;
				}
				if (issue) segments.push({ type: 'issue', value: issue });
			} else if (match[2]) {
				const ref = match[2];
				const issue = issueMap.get(ref);
				if (issue) segments.push({ type: 'issue', value: issue });
			}
			lastIndex = end;
		}
		const rest = text.slice(lastIndex);
		if (rest.trim() && !/^[\s,\.-]+$/.test(rest)) segments.push({ type: 'text', value: rest });
		return segments;
	};
</script>

<div class="space-y-3">
	{#if !messages?.length}
		<div class="mt-3 text-sm text-neutral-500">No messages yet.</div>
	{:else}
		<div class="space-y-4">
			{#each messages as m (m.id)}
				{@const isAgent = m?.sender === 'agent'}
				{@const bubbleText = m?.message ?? ''}
				{#if isAgent}
					{#each parseSegments(bubbleText) as segment}
						{#if segment.type === 'text'}
							<div class="w-full">
								<div class="w-full max-w-[85%] rounded-2xl px-4 py-4 text-left">
									<div class="text-base leading-relaxed whitespace-pre-wrap text-neutral-800">
										{segment.value}
									</div>
								</div>
							</div>
						{:else if segment.type === 'issue'}
							<div class="w-full">
								<ChatIssueRow issue={segment.value} />
							</div>
						{/if}
					{/each}
				{:else}
					<div class="flex w-full justify-end">
						<div class="w-full max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-4 text-left">
							<div class="text-base leading-relaxed whitespace-pre-wrap text-neutral-800">
								{bubbleText}
							</div>
						</div>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
