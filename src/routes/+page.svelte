<script lang="ts">
	import skyline from '$lib/assets/skyline.png';
	import imessageIcon from '$lib/assets/imessage-icon.png';
	import bedrockWordmark from '$lib/assets/bedrock-wordmark.svg?raw';
	import { onMount } from 'svelte';

	const PHONE = '6504443716';
	const SMS_BODY = encodeURIComponent("let's run through a demo maintenance request together");
	const IMESSAGE_HREF = `sms:${PHONE}&body=${SMS_BODY}`;

	const WORDS = ['responds', 'dispatches', 'follows up', 'works'];
	let wordIndex = 0;
	let displayWord = WORDS[0];
	let visible = true;
	let containerWidth = 0;
	let maxWidth = 0;
	let suppressTransition = false;
	let wordEl: HTMLSpanElement;
	let widths: number[] = [];

	onMount(() => {
		document.documentElement.classList.add('is-landing');
		document.body.classList.add('is-landing');

		const clone = wordEl.cloneNode(true) as HTMLSpanElement;
		clone.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
		wordEl.parentElement!.appendChild(clone);
		for (const word of WORDS) {
			clone.textContent = word;
			widths.push(clone.offsetWidth);
		}
		clone.remove();
		maxWidth = Math.max(...widths);

		// On mobile, suppress the entrance width transition (0 → first-word-width)
		// so the entrance has no horizontal movement. Per-word transitions
		// afterward animate normally.
		const isMobile = window.matchMedia('(max-width: 639px)').matches;
		if (isMobile) {
			suppressTransition = true;
			containerWidth = widths[0];
			// Two RAFs ensure the width was applied with no transition before
			// we re-enable transitions for future word changes.
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					suppressTransition = false;
				});
			});
		} else {
			containerWidth = widths[0];
		}

		const interval = setInterval(async () => {
			visible = false;
			await new Promise((r) => setTimeout(r, 200));
			wordIndex = (wordIndex + 1) % WORDS.length;
			displayWord = WORDS[wordIndex];
			containerWidth = widths[wordIndex];
			visible = true;
		}, 3200);
		return () => {
			clearInterval(interval);
			document.documentElement.classList.remove('is-landing');
			document.body.classList.remove('is-landing');
		};
	});
</script>

<svelte:head>
	<title>Bedrock</title>
	<meta name="description" content="Your maintenance inbox, handled. Text Bedrock to get started." />
</svelte:head>

<div
	class="relative flex flex-col overflow-hidden text-stone-900"
	style="background: #E8E6E1; min-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom));"
>

	<!-- Nav -->
	<header class="relative z-20 flex items-center justify-between px-8 py-6">
		<a href="/" class="logo-link text-stone-700" aria-label="Bedrock">
			{@html bedrockWordmark}
		</a>
		<a href="/login" class="text-sm text-stone-500 transition hover:text-stone-900">Log in</a>
	</header>

	<!-- Hero -->
	<main class="relative z-10 flex flex-1 flex-col items-center px-4 text-center sm:px-6">
		<!-- Hero text — centered on desktop, upper-center on mobile -->
		<div class="flex flex-1 flex-col items-center justify-center sm:pb-48">
				<div class="mb-5">
					<span class="px-4 py-1.5 text-xs italic text-stone-500">Helping manage 400+ units</span>
				</div>
			<h1 class="anim-hero w-full font-medium leading-tight tracking-tight text-stone-700">
				<div class="whitespace-nowrap" style="font-size: clamp(1.7rem, 10.5vw, 3.75rem);">Bedrock <span
						class="flip-container italic text-stone-600"
						class:no-transition={suppressTransition}
						style="--w: {containerWidth}px; --max-w: {maxWidth}px;"
					><span
						bind:this={wordEl}
						class="flip-word"
						class:word-hidden={!visible}
					>{displayWord}</span></span><br class="sm:hidden"> for you.</div>
				<div class="mt-1 font-normal text-stone-500" style="font-size: clamp(1rem, 5vw, 2rem);">Just send a text message.</div>
			</h1>

			<!-- CTA: visible only on desktop (sm+) -->
			<div class="anim-cta mt-8 hidden flex-col items-center gap-3 sm:flex">
				<a
					href={IMESSAGE_HREF}
					class="inline-flex items-center gap-3 rounded-full bg-black/80 px-12 py-3.5 text-2xl font-medium text-white transition hover:bg-black/90"
				>
					<img src={imessageIcon} alt="iMessage" width="32" height="32" />
					Try it now
				</a>
				<p class="text-[11px] text-stone-400">
					By continuing, you agree to our
					<a href="/terms" class="underline underline-offset-2 hover:text-stone-600">Terms</a>
					and
					<a href="/privacy" class="underline underline-offset-2 hover:text-stone-600">Privacy</a>.
				</p>
			</div>
		</div>

		<!-- CTA: pinned to bottom on mobile -->
		<div class="anim-cta z-20 w-full pb-10 pt-12 sm:hidden">
			<a
				href={IMESSAGE_HREF}
				class="mx-auto flex w-3/4 items-center justify-center gap-3 rounded-full bg-black/80 py-3 text-lg font-medium text-white transition hover:bg-black/90"
			>
				<img src={imessageIcon} alt="iMessage" width="28" height="28" />
				Try it now
			</a>
			<p class="mt-2 text-center text-[11px] text-stone-400">
				By continuing, you agree to our
				<a href="/terms" class="underline underline-offset-2 hover:text-stone-600">Terms</a>
				and
				<a href="/privacy" class="underline underline-offset-2 hover:text-stone-600">Privacy</a>.
			</p>
		</div>
	</main>

	<!-- Skyline anchored above footer with bottom fade-out to beige -->
	<div class="pointer-events-none absolute inset-0 z-0 overflow-hidden" style="background: #E8E6E1;">
		<img
			src={skyline}
			alt=""
			class="h-full w-full object-cover opacity-40"
			style="object-position: center 40%;"
		/>
		<!-- Fade overlay: skyline melts into the page bg toward the bottom -->
		<div class="absolute inset-x-0 bottom-0 h-1/3" style="background: linear-gradient(to bottom, transparent 0%, #E8E6E1 85%);"></div>
	</div>

	<!-- Footer -->
	<footer class="relative z-20 flex items-center justify-center gap-4 px-8 text-[13px] text-stone-400" style="height: calc(36px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom);">
		<span>© {new Date().getFullYear()} Bedrock</span>
		<a href="/terms" class="hover:text-stone-600">Terms</a>
		<a href="/privacy" class="hover:text-stone-600">Privacy</a>
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

	.flip-container {
		display: inline-block;
		white-space: nowrap;
		text-align: center;
		width: var(--w);
		transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
		will-change: width;
	}
	.flip-container.no-transition {
		transition: none;
	}
	.flip-word {
		display: inline-block;
		transition: opacity 0.2s ease;
	}
	.word-hidden {
		opacity: 0;
	}
	.logo-link {
		display: inline-block;
		line-height: 0;
	}
	.logo-link :global(svg) {
		height: 10px;
		width: auto;
		display: block;
	}
</style>
