<script>
	// @ts-nocheck

	import ChatIssueRow from '$lib/components/ChatIssueRow.svelte';
	import ChatPropertyRow from '$lib/components/ChatPropertyRow.svelte';
	import { issuesCache } from '$lib/stores/issuesCache';
	import { propertiesCache } from '$lib/stores/propertiesCache';

	export let messages = [];
	export let tenant = { name: 'Tenant', email: '' };

	const ISSUE_MARKER_REGEX = /\[\[issue:(\{[\s\S]*?\})\]\]/g;
	const ISSUE_REF_REGEX = /\[\[issue_ref:([a-zA-Z0-9.-]+)\]\]/g;
	const PROPERTY_MARKER_REGEX = /\[\[property:(\{[\s\S]*?\})\]\]/g;
	const PROPERTY_REF_REGEX = /\[\[property_ref:([a-zA-Z0-9.-]+)\]\]/g;

	$: issueMap = new Map(($issuesCache?.data?.issues ?? []).map((item) => [item.id, item]));
	$: if ($issuesCache?.data?.issues?.length) {
		for (const item of $issuesCache.data.issues) {
			if (item.readableId) issueMap.set(item.readableId, item);
		}
	}
	$: propertyMap = new Map(($propertiesCache ?? []).map((item) => [item.id, item]));
	$: if (Array.isArray($propertiesCache)) {
		for (const item of $propertiesCache) {
			if (item?.name) propertyMap.set(item.name, item);
		}
	}

	const parseSegments = (text = '') => {
		const segments = [];
		let cursor = 0;
		const emitText = (value) => {
			if (!value) return;
			const cleaned = value.replace(/[\s,\.-]+$/g, '').replace(/^[\s,\.-]+/g, '');
			if (cleaned.trim()) segments.push({ type: 'text', value: cleaned });
		};
		while (cursor < text.length) {
			const markerStart = text.indexOf('[[', cursor);
			if (markerStart === -1) {
				emitText(text.slice(cursor));
				break;
			}
			if (markerStart > cursor) {
				emitText(text.slice(cursor, markerStart));
			}
			const markerEnd = text.indexOf(']]', markerStart + 2);
			if (markerEnd === -1) {
				break;
			}
			const markerBody = text.slice(markerStart + 2, markerEnd);
			if (markerBody.startsWith('issue:')) {
				let issue = null;
				try {
					issue = JSON.parse(markerBody.slice(6));
				} catch {
					issue = null;
				}
				if (issue) segments.push({ type: 'issue', value: issue });
			} else if (markerBody.startsWith('issue_ref:')) {
				const ref = markerBody.slice(10);
				const issue = issueMap.get(ref);
				if (issue) segments.push({ type: 'issue', value: issue });
			} else if (markerBody.startsWith('property:')) {
				let property = null;
				try {
					property = JSON.parse(markerBody.slice(9));
				} catch {
					property = null;
				}
				if (property) segments.push({ type: 'property', value: property });
			} else if (markerBody.startsWith('property_ref:')) {
				const ref = markerBody.slice(13);
				const property = propertyMap.get(ref);
				if (property) segments.push({ type: 'property', value: property });
			}
			cursor = markerEnd + 2;
		}
		return segments;
	};
</script>

<div class="space-y-3">
	{#if !messages?.length}
		<div></div>
	{:else}
		<div class="space-y-5">
			{#each messages as m (m.id)}
				{@const isAgent = m?.sender === 'agent'}
				{@const bubbleText = m?.message ?? ''}
				{#if isAgent}
					<div class="space-y-1">
						{#each parseSegments(bubbleText) as segment}
							{#if segment.type === 'text'}
								<div class="w-full">
									<div class="w-full max-w-[85%] rounded-2xl px-4 py-2 text-left">
										<div class="text-base leading-relaxed whitespace-pre-wrap text-neutral-800">
											{segment.value}
										</div>
									</div>
								</div>
							{:else if segment.type === 'issue'}
								<div class="w-full">
									<ChatIssueRow issue={segment.value} />
								</div>
							{:else if segment.type === 'property'}
								<div class="w-full">
									<ChatPropertyRow property={segment.value} />
								</div>
							{/if}
						{/each}
					</div>
				{:else}
					<div class="flex w-full justify-end">
						<div class="w-full max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-2 text-left">
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
