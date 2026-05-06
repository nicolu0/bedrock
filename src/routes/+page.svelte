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
			// fade out
			visible = false;
			await new Promise((r) => setTimeout(r, 200));

			// swap word + width simultaneously so they animate together
			wordIndex = (wordIndex + 1) % WORDS.length;
			displayWord = WORDS[wordIndex];
			containerWidth = widths[wordIndex];

			// fade in
			visible = true;
		}, 3200);
		return () => clearInterval(interval);
	});
</script>

<svelte:head>
	<title>Bedrock</title>
	<meta name="description" content="Your maintenance inbox, handled. Text Bedrock to get started." />
</svelte:head>

<div
	class="relative flex min-h-screen flex-col overflow-hidden text-stone-900"
	style="background: #E8E6E1;"
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
		<h1 class="anim-hero w-full text-5xl font-medium leading-tight tracking-tight text-stone-700 sm:text-6xl">
			<div>Bedrock <span
					class="flip-container italic text-stone-600"
					style="width: {containerWidth}px"
				><span
					bind:this={wordEl}
					class="flip-word"
					class:word-hidden={!visible}
				>{displayWord}</span></span> for you.</div>
			<div>Just send a text.</div>
		</h1>
		<div class="anim-cta mt-8 flex flex-col items-center gap-3">
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
	<div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[56px]" style="background: #080808;"></div>

	<!-- Footer -->
	<footer class="relative z-20 flex h-[56px] items-center justify-center gap-4 px-8 text-[13px] text-white/30">
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
