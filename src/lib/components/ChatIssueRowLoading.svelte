<div class="w-full px-4 py-2">
	<div class="loading-rect"></div>
</div>

<style>
	.loading-rect {
		height: 44px;
		width: 100%;
		border-radius: 10px;
		background: linear-gradient(
			90deg,
			rgba(229, 231, 235, 0.4) 0%,
			rgba(209, 213, 219, 0.9) 50%,
			rgba(229, 231, 235, 0.4) 100%
		);
		background-size: 200% 100%;
		animation: loading-sheen 1.2s ease-in-out infinite;
	}

	@keyframes loading-sheen {
		0% {
			background-position: 0% 50%;
		}
		100% {
			background-position: 200% 50%;
		}
	}
</style>
