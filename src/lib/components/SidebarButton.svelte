<script>
	// @ts-nocheck
	import { getContext } from 'svelte';

	export let onClick = null;

	const sidebarControl = getContext('sidebarControl');
	const openSidebar = () => sidebarControl?.open?.();
	const handleClick = () => {
		if (onClick) {
			onClick();
			return;
		}
		openSidebar();
	};
</script>

<button
	type="button"
	aria-label="Open sidebar"
	class="rounded-md p-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800"
	on:click={handleClick}
>
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		fill="currentColor"
		class="bi bi-layout-sidebar-inset-reverse"
		viewBox="0 0 16 16"
	>
		<path
			d="M2 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zm12-1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z"
		/>
		<path d="M13 4a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z" />
	</svg>
</button>
