/**
 * @fileoverview Reactive Online/Offline State Detector.
 *
 * Provides a Svelte 5 reactive state (`$state`) that tracks whether the
 * browser is currently online or offline. Uses two detection methods:
 *
 *   1. **`navigator.onLine`**: Initial state check on creation.
 *   2. **`online`/`offline` events**: Real-time updates when connectivity changes.
 *
 * Usage:
 * ```svelte
 * <script lang="ts">
 *   import { createOnlineState } from '$lib/offline.svelte.js';
 *   const online = createOnlineState();
 * </script>
 *
 * {#if !online.current}
 *   <div class="offline-badge">Offline</div>
 * {/if}
 * ```
 *
 * The state is reactive: when the browser goes online/offline, any Svelte
 * components using `online.current` will automatically re-render.
 *
 * Note: `navigator.onLine` can have false positives (returns true when
 * connected to a LAN but no internet). The app handles this gracefully
 * by catching fetch errors as a secondary offline indicator.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine
 */

/**
 * Creates a reactive online/offline state tracker.
 *
 * Returns an object with a reactive `current` property that reflects
 * the browser's current online/offline status. Event listeners are
 * added on creation and cleaned up via the returned `destroy()` method.
 *
 * @returns An object with:
 *   - `current`: boolean — true if online, false if offline (reactive)
 *   - `destroy()`: Removes event listeners (call on component unmount)
 */
export function createOnlineState(): { readonly current: boolean; destroy: () => void } {
	/* Initial state from navigator.onLine (true if browser thinks it's online). */
	let isOnline = $state(typeof navigator !== 'undefined' ? navigator.onLine : true);

	/** Handler for the browser 'online' event. */
	function handleOnline(): void {
		isOnline = true;
	}

	/** Handler for the browser 'offline' event. */
	function handleOffline(): void {
		isOnline = false;
	}

	/* Register event listeners if running in a browser environment. */
	if (typeof window !== 'undefined') {
		window.addEventListener('online', handleOnline);
		window.addEventListener('offline', handleOffline);
	}

	return {
		/** Whether the browser is currently online. Reactive ($state). */
		get current() {
			return isOnline;
		},

		/**
		 * Removes event listeners. Call this when the component using this
		 * state is destroyed to prevent memory leaks.
		 */
		destroy() {
			if (typeof window !== 'undefined') {
				window.removeEventListener('online', handleOnline);
				window.removeEventListener('offline', handleOffline);
			}
		}
	};
}
