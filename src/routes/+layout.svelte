<script lang="ts">
	import './layout.css';
	import bedrockLogo from '$lib/assets/bedrock-logo.png';
	import { onNavigate } from '$app/navigation';

	let { children } = $props();

	onNavigate((navigation) => {
		const fromLanding = navigation.from?.url.pathname === '/';
		const toAuth = ['/login', '/signup'].includes(navigation.to?.url.pathname ?? '');
		if (!fromLanding || !toAuth) return;

		document.documentElement.classList.add('is-navigating');
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				document.documentElement.classList.remove('is-navigating');
				resolve();
			}, 350);
		});
	});
</script>

<svelte:head>
	<title>Bedrock</title>
	<link rel="icon" href={bedrockLogo} />
</svelte:head>
{@render children()}
