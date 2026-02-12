<!--
  @component Diagnostics Page

  Developer/support diagnostics at /diagnostics. No authentication required.

  Features:
    - IndexedDB cache statistics (thread count, detail count, total size)
    - Service Worker status and version
    - Online/offline connectivity indicator
    - Actions: clear all caches, force SW update
    - Themed with light/dark mode via the theme store
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { theme, toggleTheme, initTheme } from '$lib/stores/theme';
	import { getCacheStats, clearAllCaches } from '$lib/cache.js';
	import { createOnlineState } from '$lib/offline.svelte.js';

	// =========================================================================
	// State
	// =========================================================================

	/** Whether the diagnostics data is loading. */
	let loading: boolean = $state(true);

	/** Reactive online/offline state. */
	const online = createOnlineState();

	// ── Cache Stats ──────────────────────────────────────────────────
	/** Number of cached thread metadata entries. */
	let metaCount: number = $state(0);

	/** Number of cached thread detail entries. */
	let detailCount: number = $state(0);

	// ── Service Worker ───────────────────────────────────────────────
	/** Current SW registration state. */
	let swStatus: string = $state('Unknown');

	/** Whether a SW update is available. */
	let swUpdateAvailable: boolean = $state(false);

	// ── Actions ──────────────────────────────────────────────────────
	/** Whether a cache clear operation is in progress. */
	let clearing: boolean = $state(false);

	/** Status message from the last action (shown as feedback). */
	let actionMessage: string | null = $state(null);

	// =========================================================================
	// Data Fetching
	// =========================================================================

	/** Loads cache statistics from IndexedDB. */
	async function loadCacheStats(): Promise<void> {
		try {
			const stats = await getCacheStats();
			metaCount = stats.metadataCount;
			detailCount = stats.detailCount;
		} catch {
			/* IndexedDB not available — leave zeros. */
		}
	}

	/** Checks the current Service Worker registration status. */
	async function checkServiceWorker(): Promise<void> {
		if (!('serviceWorker' in navigator)) {
			swStatus = 'Not supported';
			return;
		}

		try {
			const registration = await navigator.serviceWorker.getRegistration();
			if (!registration) {
				swStatus = 'Not registered';
				return;
			}

			if (registration.waiting) {
				swStatus = 'Update waiting';
				swUpdateAvailable = true;
			} else if (registration.installing) {
				swStatus = 'Installing';
			} else if (registration.active) {
				swStatus = 'Active';
			} else {
				swStatus = 'Registered (no active worker)';
			}
		} catch {
			swStatus = 'Error checking status';
		}
	}

	// =========================================================================
	// Actions
	// =========================================================================

	/**
	 * Clears all IndexedDB caches (thread metadata + thread details).
	 * Reloads cache stats after clearing.
	 */
	async function handleClearCaches(): Promise<void> {
		clearing = true;
		actionMessage = null;

		try {
			await clearAllCaches();
			await loadCacheStats();
			actionMessage = 'All caches cleared successfully.';
		} catch (err) {
			actionMessage = `Failed to clear caches: ${err instanceof Error ? err.message : 'Unknown error'}`;
		} finally {
			clearing = false;
		}
	}

	/**
	 * Forces the waiting Service Worker to activate immediately.
	 * This triggers a page reload to pick up the new SW version.
	 */
	async function handleForceSwUpdate(): Promise<void> {
		actionMessage = null;

		try {
			const registration = await navigator.serviceWorker.getRegistration();
			if (registration?.waiting) {
				registration.waiting.postMessage({ type: 'SKIP_WAITING' });
				actionMessage = 'Service Worker updated. Reloading...';
				/* Brief delay so the user sees the message before reload. */
				setTimeout(() => location.reload(), 500);
			} else {
				actionMessage = 'No waiting Service Worker found.';
			}
		} catch (err) {
			actionMessage = `Failed to update SW: ${err instanceof Error ? err.message : 'Unknown error'}`;
		}
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	onMount(async () => {
		initTheme();
		await Promise.all([loadCacheStats(), checkServiceWorker()]);
		loading = false;
	});

	onDestroy(() => {
		online.destroy();
	});
</script>

<svelte:head>
	<title>Diagnostics - Email Switchboard</title>
</svelte:head>

<div class="diag-shell">
	<!-- ── Header ──────────────────────────────────────────────────── -->
	<header class="diag-header">
		<div class="header-left">
			<a href="/" class="back-link">
				<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
					<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
				</svg>
				Back to inbox
			</a>
			<span class="diag-title">Diagnostics</span>
		</div>
		<div class="header-right">
			<button class="theme-toggle" onclick={toggleTheme} title="Toggle dark mode">
				{#if $theme === 'dark'}
					<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
						<path
							d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 000-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"
						/>
					</svg>
				{:else}
					<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
						<path
							d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 01-4.4 2.26 5.403 5.403 0 01-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"
						/>
					</svg>
				{/if}
			</button>
		</div>
	</header>

	<!-- ── Content ─────────────────────────────────────────────────── -->
	<main id="main-content" class="diag-content">
		{#if loading}
			<div class="diag-loading">
				<div class="spinner"></div>
				<p>Loading diagnostics...</p>
			</div>
		{:else}
			<!-- Connectivity -->
			<section class="diag-section">
				<h2>Connectivity</h2>
				<div class="diag-row">
					<span class="diag-label">Status</span>
					<span
						class="diag-value"
						class:online-status={online.current}
						class:offline-status={!online.current}
					>
						{online.current ? 'Online' : 'Offline'}
					</span>
				</div>
			</section>

			<!-- Cache Statistics -->
			<section class="diag-section">
				<h2>IndexedDB Cache</h2>
				<div class="diag-row">
					<span class="diag-label">Thread metadata entries</span>
					<span class="diag-value">{metaCount}</span>
				</div>
				<div class="diag-row">
					<span class="diag-label">Thread detail entries</span>
					<span class="diag-value">{detailCount}</span>
				</div>
				<div class="diag-actions">
					<button class="btn-danger-sm" onclick={handleClearCaches} disabled={clearing}>
						{clearing ? 'Clearing...' : 'Clear all caches'}
					</button>
				</div>
			</section>

			<!-- Service Worker -->
			<section class="diag-section">
				<h2>Service Worker</h2>
				<div class="diag-row">
					<span class="diag-label">Status</span>
					<span class="diag-value">{swStatus}</span>
				</div>
				{#if swUpdateAvailable}
					<div class="diag-actions">
						<button class="btn-primary-sm" onclick={handleForceSwUpdate}> Force update now </button>
					</div>
				{/if}
			</section>

			<!-- Action Feedback -->
			{#if actionMessage}
				<div class="action-feedback" role="status">
					{actionMessage}
				</div>
			{/if}
		{/if}
	</main>
</div>

<style>
	/* ── Shell ─────────────────────────────────────────────────────── */
	.diag-shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		background: var(--color-bg-primary);
	}

	/* ── Header ────────────────────────────────────────────────────── */
	.diag-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		background: var(--color-bg-surface);
		border-bottom: 1px solid var(--color-border);
		height: 64px;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.header-right {
		display: flex;
		align-items: center;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--color-text-secondary);
		text-decoration: none;
		font-size: 14px;
		padding: 8px 12px;
		border-radius: 4px;
	}

	.back-link:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-primary);
		text-decoration: none;
	}

	.diag-title {
		font-size: 18px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.theme-toggle {
		padding: 8px;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-secondary);
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.theme-toggle:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	/* ── Content ───────────────────────────────────────────────────── */
	.diag-content {
		max-width: 640px;
		margin: 0 auto;
		padding: 24px;
		width: 100%;
		box-sizing: border-box;
	}

	.diag-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 60px 24px;
		color: var(--color-text-secondary);
		gap: 12px;
	}

	.spinner {
		width: 32px;
		height: 32px;
		border: 3px solid var(--color-border);
		border-top-color: var(--color-primary);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ── Sections ──────────────────────────────────────────────────── */
	.diag-section {
		background: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 20px;
		margin-bottom: 16px;
	}

	.diag-section h2 {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0 0 12px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.diag-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.diag-row:last-of-type {
		border-bottom: none;
	}

	.diag-label {
		font-size: 14px;
		color: var(--color-text-secondary);
	}

	.diag-value {
		font-size: 14px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.online-status {
		color: #34a853;
	}

	.offline-status {
		color: var(--color-warning);
	}

	/* ── Action Buttons ───────────────────────────────────────────── */
	.diag-actions {
		margin-top: 12px;
	}

	.btn-danger-sm {
		padding: 6px 16px;
		font-size: 13px;
		color: #fff;
		background: var(--color-error);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
	}

	.btn-danger-sm:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn-danger-sm:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-primary-sm {
		padding: 6px 16px;
		font-size: 13px;
		color: var(--color-tab-badge-text);
		background: var(--color-primary);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
	}

	.btn-primary-sm:hover {
		background: var(--color-primary-hover);
	}

	/* ── Feedback ──────────────────────────────────────────────────── */
	.action-feedback {
		padding: 12px 16px;
		font-size: 13px;
		color: var(--color-text-primary);
		background: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		text-align: center;
	}
</style>
