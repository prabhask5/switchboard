<!--
  @component Offline Banner

  A fixed pill-shaped banner near the bottom of the viewport that appears
  when the user loses internet connectivity. Automatically hides when the
  connection is restored.

  Uses the browser's `online`/`offline` events to reactively track network
  state. Self-contained — no props required. Include once in the root layout
  so it works on every page.

  Based on the same pattern used in the shortless-yt project.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';

	/**
	 * Whether the browser is currently offline.
	 * Drives conditional rendering of the banner.
	 */
	let offline = $state(false);

	/**
	 * Lifecycle: initializes network status tracking.
	 * Sets the initial state from `navigator.onLine`, then registers
	 * event listeners for real-time online/offline transitions. Returns
	 * a cleanup function that removes the listeners on component destroy.
	 */
	onMount(() => {
		if (!browser) return;

		/* Set initial state based on current connectivity. */
		offline = !navigator.onLine;

		/** Handler for the browser's 'offline' event — shows banner. */
		const goOffline = () => {
			offline = true;
		};

		/** Handler for the browser's 'online' event — hides banner. */
		const goOnline = () => {
			offline = false;
		};

		window.addEventListener('offline', goOffline);
		window.addEventListener('online', goOnline);

		/* Svelte onMount cleanup: remove listeners on unmount. */
		return () => {
			window.removeEventListener('offline', goOffline);
			window.removeEventListener('online', goOnline);
		};
	});
</script>

<!-- Reactively shown/hidden as the browser's network state changes -->
{#if offline}
	<div class="offline-banner" role="alert">
		<!-- Wi-Fi signal icon (Material Design) indicating no connectivity -->
		<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path
				d="M24 8.98A16.88 16.88 0 0012 4C7.31 4 3.07 5.9 0 8.98l2 2.27A13.91 13.91 0 0112 7c3.48 0 6.63 1.26 9.08 3.33L24 8.98zM2.92 13.07l2 2.27A9.8 9.8 0 0112 12c2.7 0 5.13 1.04 6.93 2.74l2-2.27A12.83 12.83 0 0012 9c-3.6 0-6.86 1.41-9.08 3.07zM12 15c-1.63 0-3.06.6-4.17 1.57l2 2.27a3.43 3.43 0 012.17-.84c.8 0 1.56.31 2.17.84l2-2.27A6.45 6.45 0 0012 15z"
			/>
		</svg>
		<span>You're offline. Some features may not work.</span>
	</div>
{/if}

<style>
	.offline-banner {
		position: fixed;
		bottom: 16px;
		left: 50%;
		transform: translateX(-50%);
		background: #3c4043;
		color: #e8eaed;
		padding: 8px 20px;
		border-radius: 24px;
		font-size: 13px;
		display: flex;
		align-items: center;
		gap: 8px;
		z-index: 500;
		box-shadow:
			0 2px 6px rgba(0, 0, 0, 0.15),
			0 1px 2px rgba(0, 0, 0, 0.1);
		white-space: nowrap;
	}
</style>
