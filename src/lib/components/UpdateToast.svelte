<!--
  @component Update Toast

  Displays a fixed-position toast notification at the bottom of the screen when a
  new service worker version has been installed and is waiting to activate. Provides
  the user with "Update" (to reload with the new SW) and "Dismiss" (to hide the toast)
  actions. Uses multiple detection strategies to catch waiting workers reliably across
  browsers and platforms (especially iOS PWA where timing can be inconsistent).

  6 detection strategies:
    1. Immediate + delayed polling (handles iOS PWA timing)
    2. SW_INSTALLED message listener from the service worker
    3. Native updatefound event + statechange tracking
    4. visibilitychange triggered update check (mobile/PWA background)
    5. Periodic polling (every 2 minutes)
    6. Immediate registration.update() on page load
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';

	/** @state Tracks whether the update toast should be visible to the user. */
	let show = $state(false);

	/**
	 * Guard flag to prevent multiple reload attempts if the user taps "Update"
	 * rapidly. Not reactive ($state) because the UI hides immediately on click
	 * and we only need a simple JS-level guard.
	 */
	let reloading = false;

	/**
	 * Lifecycle: sets up all service worker update detection mechanisms.
	 * Runs only in the browser and only when the Service Worker API is available.
	 */
	onMount(() => {
		if (!browser || !navigator.serviceWorker) return;

		/**
		 * Queries the current SW registration for a worker in the "waiting" state.
		 * A waiting worker means a new version has been downloaded and installed
		 * but has not yet taken control of the page.
		 */
		function checkForWaitingWorker() {
			navigator.serviceWorker.getRegistration().then((registration) => {
				if (registration?.waiting) {
					show = true;
				}
			});
		}

		// --- Strategy 1: Immediate + delayed polling ---
		// Check right away in case a waiting worker already exists from a prior visit.
		checkForWaitingWorker();

		// Delayed checks: iOS PWA sometimes reports the waiting worker with a delay
		// after the page becomes visible, so we re-check after 1s and 3s.
		setTimeout(checkForWaitingWorker, 1000);
		setTimeout(checkForWaitingWorker, 3000);

		// --- Strategy 2: Listen for custom SW_INSTALLED message ---
		// The service worker (static/sw.js) posts this message when it finishes
		// installing. We wait 500ms before checking to let the browser transition
		// the worker to the "waiting" state.
		navigator.serviceWorker.addEventListener('message', (event) => {
			if (event.data?.type === 'SW_INSTALLED') {
				setTimeout(checkForWaitingWorker, 500);
			}
		});

		// --- Strategy 3: Native updatefound event ---
		// When the browser detects a byte-different SW script, it fires "updatefound"
		// on the registration. We then track the new installing worker's state until
		// it becomes "installed". The `navigator.serviceWorker.controller` check
		// ensures this is an *update* (not the very first install).
		navigator.serviceWorker.ready.then((registration) => {
			// The registration may already have a waiting worker by the time .ready resolves
			if (registration.waiting) {
				show = true;
			}

			registration.addEventListener('updatefound', () => {
				const newWorker = registration.installing;
				if (!newWorker) return;

				newWorker.addEventListener('statechange', () => {
					if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
						show = true;
					}
				});
			});
		});

		// --- Strategy 4: Visibility-change triggered update check ---
		// Critical for mobile/PWA: when the user switches back to the app after it
		// has been backgrounded, we ask the browser to re-fetch the SW script and
		// also re-check for a waiting worker after a short delay.
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				navigator.serviceWorker.ready.then((reg) => reg.update());
				setTimeout(checkForWaitingWorker, 1000);
			}
		});

		// --- Strategy 5: Periodic polling ---
		// Every 2 minutes, proactively ask the browser to check for a new SW script.
		// This ensures long-lived tabs eventually discover updates.
		setInterval(
			() => {
				navigator.serviceWorker.ready.then((reg) => reg.update());
			},
			2 * 60 * 1000
		);

		// --- Strategy 6: Immediate update check on page load ---
		// Force an update check as soon as the SW registration is ready.
		navigator.serviceWorker.ready.then((reg) => reg.update());
	});

	/**
	 * Activates the waiting service worker and reloads the page so the user
	 * picks up the new version. Sends a "SKIP_WAITING" message to the waiting
	 * worker, which triggers it to call self.skipWaiting(). Once the new worker
	 * takes control (controllerchange event), the page reloads. If no waiting
	 * worker is found (edge case), falls back to a plain reload.
	 */
	function reload() {
		// Prevent double-invocation (e.g., rapid taps)
		if (reloading) return;
		reloading = true;
		show = false;

		navigator.serviceWorker.getRegistration().then((registration) => {
			if (registration?.waiting) {
				// Listen for the moment the new worker takes control, then reload
				navigator.serviceWorker.addEventListener(
					'controllerchange',
					() => window.location.reload(),
					{ once: true }
				);
				// Tell the waiting worker to activate immediately
				registration.waiting.postMessage({ type: 'SKIP_WAITING' });
			} else {
				// Fallback: no waiting worker found, just reload
				window.location.reload();
			}
		});
	}

	/**
	 * Hides the update toast without triggering a reload. The toast may
	 * reappear on the next visibility change or periodic check if the
	 * waiting worker is still present.
	 */
	function dismiss() {
		show = false;
	}
</script>

<!-- Toast is conditionally rendered only when a waiting SW is detected -->
{#if show}
	<div class="update-toast" role="alert">
		<div class="toast-inner">
			<!-- Refresh/reload icon (Material Design) -->
			<svg class="toast-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
				<path
					d="M21 10.12h-6.78l2.74-2.82c-2.73-2.7-7.15-2.8-9.88-.1a6.875 6.875 0 000 9.79 7.02 7.02 0 009.88 0C18.32 15.65 19 14.08 19 12.1h2c0 2.08-.56 4.15-2.34 5.93a8.981 8.981 0 01-12.73 0 9.004 9.004 0 010-12.73 8.98 8.98 0 0112.73 0L21 3v7.12z"
				/>
			</svg>
			<span class="toast-text">A new version is available</span>
			<!-- "Update" activates the waiting SW and reloads the page -->
			<button class="toast-action" onclick={reload}>Update</button>
			<!-- "Dismiss" hides the toast without activating the new SW -->
			<button class="toast-dismiss" onclick={dismiss} aria-label="Dismiss">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
					<path
						d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
					/>
				</svg>
			</button>
		</div>
	</div>
{/if}

<style>
	.update-toast {
		position: fixed;
		bottom: 24px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 700;
		animation: slideUp 0.3s ease-out;
	}

	@keyframes slideUp {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(16px);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
	}

	.toast-inner {
		display: flex;
		align-items: center;
		gap: 12px;
		background: var(--color-bg-surface);
		color: var(--color-text-primary);
		border: 1px solid var(--color-border);
		border-radius: 24px;
		padding: 10px 12px 10px 16px;
		box-shadow: var(--color-shadow-lg);
		font-size: 14px;
		white-space: nowrap;
	}

	.toast-icon {
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}

	.toast-text {
		flex: 1;
	}

	.toast-action {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-primary);
		background: none;
		border: none;
		padding: 6px 12px;
		border-radius: 18px;
		white-space: nowrap;
		cursor: pointer;
		font-family: inherit;
	}

	.toast-action:hover {
		background: var(--color-bg-hover);
	}

	.toast-dismiss {
		flex-shrink: 0;
		color: var(--color-text-secondary);
		width: 28px;
		height: 28px;
		min-height: 28px;
		background: none;
		border: none;
		border-radius: 50%;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	.toast-dismiss:hover {
		color: var(--color-text-primary);
		background: var(--color-bg-hover);
	}

	@media (max-width: 768px) {
		.update-toast {
			bottom: 24px;
			left: 12px;
			right: 12px;
			transform: none;
		}

		@keyframes slideUp {
			from {
				opacity: 0;
				transform: translateY(16px);
			}
			to {
				opacity: 1;
				transform: translateY(0);
			}
		}
	}
</style>
