<script lang="ts">
	import skyline from '$lib/assets/skyline.png';
	import imessageIcon from '$lib/assets/imessage-icon.png';
	import { onMount } from 'svelte';

	const PHONE = '6504443716';
	const SMS_BODY = encodeURIComponent("let's run through a demo maintenance request together");
	const IMESSAGE_HREF = `sms:${PHONE}&body=${SMS_BODY}`;

	const WORDS = ['responds', 'dispatches', 'follows up', 'works'];
	let wordIndex = 0;
	let displayWord = WORDS[0];
	let visible = true;
	let containerWidth = 0;
	let wordEl: HTMLSpanElement;
	let widths: number[] = [];

	onMount(() => {
		const clone = wordEl.cloneNode(true) as HTMLSpanElement;
		clone.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
		wordEl.parentElement!.appendChild(clone);
		for (const word of WORDS) {
			clone.textContent = word;
			widths.push(clone.offsetWidth);
		}
		clone.remove();
		containerWidth = widths[0];

		const interval = setInterval(async () => {
			visible = false;
			await new Promise((r) => setTimeout(r, 200));
			wordIndex = (wordIndex + 1) % WORDS.length;
			displayWord = WORDS[wordIndex];
			containerWidth = widths[wordIndex];
			visible = true;
		}, 3200);
		return () => clearInterval(interval);
	});
</script>

<svelte:head>
	<title>Bedrock</title>
	<meta name="description" content="Your maintenance inbox, handled. Text Bedrock to get started." />
</svelte:head>

<!-- Safe area color fills -->
<div class="fixed inset-x-0 top-0 z-50" style="height: env(safe-area-inset-top); background: #E8E6E1;"></div>
<div class="fixed inset-x-0 bottom-0 z-50" style="height: env(safe-area-inset-bottom); background: #080808;"></div>

<div
	class="relative flex flex-col overflow-hidden text-stone-900"
	style="background: #E8E6E1; min-height: 100dvh; padding-top: env(safe-area-inset-top);"
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
	<main class="relative z-10 flex flex-1 flex-col items-center px-6 text-center">
		<!-- Hero text — centered on desktop, upper-center on mobile -->
		<div class="flex flex-1 flex-col items-center justify-center sm:pb-48">
			<h1 class="anim-hero w-full font-medium leading-tight tracking-tight text-stone-700" style="font-size: clamp(1.2rem, 7.2vw, 3.75rem);">
				<div class="whitespace-nowrap">Bedrock <span
						class="flip-container italic text-stone-600"
						style="width: {containerWidth}px"
					><span
						bind:this={wordEl}
						class="flip-word"
						class:word-hidden={!visible}
					>{displayWord}</span></span> for you.</div>
				<div>Just send a text.</div>
			</h1>

			<!-- CTA: visible only on desktop (sm+) -->
			<div class="anim-cta mt-8 hidden flex-col items-center gap-3 sm:flex">
				<a
					href={IMESSAGE_HREF}
					class="inline-flex items-center gap-3 rounded-full bg-stone-700 px-12 py-3.5 text-2xl font-medium text-white transition hover:bg-stone-600"
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
		<div class="anim-cta z-20 w-full pb-20 sm:hidden">
			<a
				href={IMESSAGE_HREF}
				class="mx-auto flex w-3/4 items-center justify-center gap-3 rounded-full bg-stone-700 py-3 text-lg font-medium text-white transition hover:bg-stone-600"
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

	<!-- Skyline anchored above footer -->
	<div class="pointer-events-none absolute inset-0 z-0 overflow-hidden" style="background: #E8E6E1;">
		<img
			src={skyline}
			alt=""
			class="h-full w-full object-cover opacity-40"
			style="object-position: center 40%;"
		/>
	</div>

	<!-- Footer background -->
	<div class="pointer-events-none absolute inset-x-0 bottom-0 z-10" style="background: #080808; height: calc(56px + env(safe-area-inset-bottom));"></div>

	<!-- Footer -->
	<footer class="relative z-20 flex items-center justify-center gap-4 px-8 text-[13px] text-white/30" style="height: calc(56px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom);">
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

	.flip-container {
		display: inline-block;
		white-space: nowrap;
		text-align: center;
		transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
		will-change: width;
	}
	.flip-word {
		display: inline-block;
		transition: opacity 0.2s ease;
	}
	.word-hidden {
		opacity: 0;
	}
</style>
