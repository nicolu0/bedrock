<script lang="ts">
	import './layout.css';
	import bedrockLogo from '$lib/assets/bedrock-logo.png';

	let { children } = $props();
</script>

<svelte:head>
	<title>Bedrock</title>
	<link rel="icon" href={bedrockLogo} />
</svelte:head>
{@render children()}
