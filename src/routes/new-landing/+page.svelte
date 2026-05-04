<script lang="ts">
	import skyline from '$lib/assets/skyline.png';

	const PHONE = '6504443716';
	const SMS_BODY = encodeURIComponent('Hey, I want to try Bedrock');
	const IMESSAGE_HREF = `sms:${PHONE}&body=${SMS_BODY}`;
</script>

<svelte:head>
	<title>Bedrock</title>
	<meta name="description" content="Your maintenance inbox, handled. Text Bedrock to get started." />
</svelte:head>

<div
	class="relative flex min-h-screen flex-col overflow-hidden text-stone-900"
	style="background: linear-gradient(to bottom, #E8E6E1 calc(100% - 180px), #080808 calc(100% - 80px));"
>

	<!-- Nav -->
	<header class="relative z-20 flex items-center justify-between px-8 py-6">
		<a
			href="/"
			class="text-sm font-medium tracking-[0.12em] uppercase text-stone-700"
			style="font-family: 'Zalando Sans Expanded', sans-serif;"
		>
			Bedrock
		</a>
		<a href="/login" class="text-sm text-stone-500 transition hover:text-stone-900">Log in</a>
	</header>

	<!-- Hero -->
	<main class="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-48 text-center">
		<h1 class="anim-hero max-w-2xl text-5xl font-medium leading-tight tracking-tight text-stone-700 sm:text-6xl">
			<span class="italic text-stone-600">Maintenance simplified</span><br />Just text Bedrock.
		</h1>
		<p class="anim-sub mt-5 text-base text-stone-500">
			It starts with one text.
		</p>
		<div class="anim-cta mt-8 flex flex-col items-center gap-3">
			<a
				href={IMESSAGE_HREF}
				class="inline-flex items-center gap-2.5 rounded-full bg-stone-700 px-7 py-3.5 text-[15px] font-medium text-white transition hover:bg-stone-600"
			>
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
					<rect width="18" height="18" rx="5" fill="#34C759" />
					<path
						d="M9 3.5C5.96 3.5 3.5 5.68 3.5 8.38c0 1.48.74 2.8 1.91 3.71L4.9 14l2.13-1.07A6.1 6.1 0 0 0 9 13.26c3.04 0 5.5-2.18 5.5-4.88S12.04 3.5 9 3.5Z"
						fill="white"
					/>
				</svg>
				Get Started
			</a>
			<p class="text-[11px] text-stone-400">
				By continuing, you agree to our
				<a href="/terms" class="underline underline-offset-2 hover:text-stone-600">Terms</a>
				and
				<a href="/privacy" class="underline underline-offset-2 hover:text-stone-600">Privacy</a>.
			</p>
		</div>
	</main>

	<!-- Skyline anchored above footer -->
	<div class="pointer-events-none absolute inset-x-0 bottom-[52px] z-0 overflow-hidden " style="background: linear-gradient(to bottom, #E8E6E1 70%, #1a1714 100%);">
		<img
			src={skyline}
			alt=""
			class="w-full opacity-40"
			style="mask-image: linear-gradient(to bottom, black 60%, transparent 100%); -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);"
		/>
		<div class="pointer-events-none absolute inset-x-0 bottom-0 h-[180px]" style="background: linear-gradient(to bottom, transparent 30%, rgba(26,23,20,0.55) 100%);"></div>
	</div>

<!-- Footer -->
	<footer class="relative z-20 flex items-center justify-center gap-4 px-8 py-5 text-[11px] text-white/30">
		<span>© {new Date().getFullYear()} Bedrock</span>
		<a href="/terms" class="hover:text-white/60">Terms</a>
		<a href="/privacy" class="hover:text-white/60">Privacy</a>
	</footer>
</div>

<style>
	.anim-hero {
		animation: rise 1.1s cubic-bezier(0.22, 1, 0.36, 1) 0.15s both;
	}
	.anim-sub {
		animation: rise 1.1s cubic-bezier(0.22, 1, 0.36, 1) 0.35s both;
	}
	.anim-cta {
		animation: rise 1.1s cubic-bezier(0.22, 1, 0.36, 1) 0.55s both;
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(18px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
