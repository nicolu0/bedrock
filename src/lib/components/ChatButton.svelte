<script>
	// @ts-nocheck
	import { toggleChatPanel } from '$lib/stores/rightPanel.js';

	export let onClick = null;

	const handleClick = () => {
		if (onClick) {
			onClick();
			return;
		}
		toggleChatPanel();
	};
</script>

<button
	type="button"
	aria-label="Toggle chat"
	class="rounded-md p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800"
	on:click={handleClick}
>
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		fill="currentColor"
		class="bi bi-chat-left-text"
		viewBox="0 0 16 16"
	>
		<path d="M14 1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4.414L2 13.414V2a1 1 0 0 1 1-1z" />
		<path
			d="M3 3.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0 2a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0 2a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5"
		/>
	</svg>
</button>
