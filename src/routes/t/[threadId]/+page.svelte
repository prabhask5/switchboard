<!--
  @component Thread Detail Page

  Displays the full content of a single email thread at /t/[threadId].

  Features:
    - Fetches thread detail from GET /api/thread/[id]
    - Shows all messages in the thread with headers and body
    - Renders HTML email bodies in a closed Shadow DOM for CSS isolation
    - Click-to-expand/collapse messages (last message expanded by default)
    - Caches thread detail in IndexedDB for offline access
    - Stale-while-revalidate: shows cached data immediately, refreshes when online
    - Offline badge and disabled actions when offline

  Data flow:
    1. Check IndexedDB cache for this thread
    2. If cached: render immediately (stale-while-revalidate)
    3. If online: fetch fresh data from /api/thread/[id]
    4. Cache the fresh response in IndexedDB
    5. If offline and no cache: show "not available offline" message
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import type { ThreadDetail, ThreadDetailMessage, AttachmentInfo } from '$lib/types.js';
	import { getCachedThreadDetail, cacheThreadDetail } from '$lib/cache.js';
	import { createOnlineState } from '$lib/offline.svelte.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { formatDetailDate, decodeHtmlEntities } from '$lib/format.js';
	import { theme, toggleTheme } from '$lib/stores/theme';

	// =========================================================================
	// State
	// =========================================================================

	/** The thread detail data (from API or cache). */
	let thread: ThreadDetail | null = $state(null);

	/** Whether the initial load is in progress. */
	let loading: boolean = $state(true);

	/** Error message if the fetch failed. */
	let errorMessage: string | null = $state(null);

	/** Whether the current data is from cache (not yet revalidated). */
	let fromCache: boolean = $state(false);

	/**
	 * Whether the user is offline with no cached data for this thread.
	 * Rendered as a graceful informational state (not an error).
	 */
	let isOfflineNoCache: boolean = $state(false);

	/**
	 * Dismissible error from background revalidation (shown as toast).
	 * When cached data is available, background failures are non-blocking.
	 */
	let fetchError: string | null = $state(null);

	/** Reactive online/offline state. */
	const online = createOnlineState();

	/** The authenticated user's email address (for the app header). */
	let userEmail: string | null = $state(null);

	// =========================================================================
	// Data Fetching
	// =========================================================================

	/**
	 * Fetches the thread detail from the API and caches it.
	 *
	 * When cached data is already displayed, failures are shown as a
	 * dismissible toast (non-blocking) instead of replacing the page.
	 *
	 * @param threadId - The Gmail thread ID to fetch.
	 */
	async function fetchThreadDetail(threadId: string): Promise<void> {
		try {
			const res = await fetch(`/api/thread/${encodeURIComponent(threadId)}`);

			if (res.status === 401) {
				goto('/login');
				return;
			}

			if (res.status === 404) {
				if (thread) {
					/* Cached data exists — show toast instead of replacing page. */
					fetchError = 'Thread not found on server. It may have been deleted.';
				} else {
					errorMessage = 'Thread not found. It may have been deleted.';
				}
				return;
			}

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				const msg = body.message ?? `Failed to load thread (HTTP ${res.status})`;
				if (thread) {
					fetchError = msg;
				} else {
					errorMessage = msg;
				}
				return;
			}

			const data: { thread: ThreadDetail } = await res.json();
			thread = data.thread;
			fromCache = false;

			/* Cache the fresh response in IndexedDB for offline access. */
			try {
				await cacheThreadDetail(data.thread);
			} catch {
				/* Cache write failed — non-critical, just skip. */
			}
		} catch (err) {
			/*
			 * Network error — if we have cached data, show a toast.
			 * Otherwise, distinguish offline (graceful) from error.
			 */
			if (thread) {
				/* Background revalidation failed — non-blocking toast. */
				fetchError = online.current
					? err instanceof Error
						? err.message
						: 'Failed to refresh thread'
					: 'You are offline. Showing cached version.';
			} else if (!online.current) {
				/* No cache + offline — graceful state, not error. */
				isOfflineNoCache = true;
			} else {
				/* No cache + online = actual error. */
				errorMessage = err instanceof Error ? err.message : 'Failed to load thread';
			}
		} finally {
			loading = false;
		}
	}

	// =========================================================================
	// Expand / Collapse State
	// =========================================================================

	/** Set of expanded message IDs. Last message is expanded by default. */
	let expandedIds = new SvelteSet<string>();

	/** Tracks which thread we last initialized expanded state for. */
	let lastExpandedThreadId: string = '';

	/**
	 * Initialize expanded state when a new thread loads.
	 * Only the last (most recent) message is expanded by default.
	 * Skips re-initialization when the same thread revalidates from cache.
	 */
	$effect(() => {
		if (thread && thread.id !== lastExpandedThreadId) {
			lastExpandedThreadId = thread.id;
			expandedIds.clear();
			if (thread.messages.length > 0) {
				expandedIds.add(thread.messages[thread.messages.length - 1].id);
			}
		}
	});

	/**
	 * Toggles a message between expanded and collapsed states.
	 * @param msgId - The Gmail message ID to toggle.
	 */
	function toggleMessage(msgId: string): void {
		if (expandedIds.has(msgId)) {
			expandedIds.delete(msgId);
		} else {
			expandedIds.add(msgId);
		}
	}

	// =========================================================================
	// UI Helpers
	// =========================================================================

	/**
	 * Returns a display name for the sender.
	 * Shows the name if available, otherwise the email prefix.
	 */
	function senderDisplay(msg: ThreadDetailMessage): string {
		if (msg.from.name) return msg.from.name;
		const atIdx = msg.from.email.indexOf('@');
		return atIdx > 0 ? msg.from.email.slice(0, atIdx) : msg.from.email;
	}

	// =========================================================================
	// Shadow DOM Rendering
	// =========================================================================

	/**
	 * Svelte action that renders sanitized email HTML inside a Shadow DOM
	 * for CSS isolation (email styles don't leak to app, app styles don't
	 * leak to email content). Shadow DOM is used instead of an iframe for
	 * a more seamless, lightweight rendering experience.
	 *
	 * Uses `mode: 'closed'` so external scripts cannot reach into the
	 * shadow root (defense-in-depth — even though we strip scripts,
	 * `closed` prevents any escaped content from accessing the DOM tree).
	 *
	 * Dark mode support:
	 *   - Injects a style element that uses CSS filter `invert(1) hue-rotate(180deg)`
	 *     to invert colors when the app is in dark mode.
	 *   - Images/videos are double-inverted to preserve their original appearance.
	 *   - A MutationObserver watches `document.documentElement[data-theme]`
	 *     to sync the dark mode class live when the user toggles the theme.
	 *
	 * @param node - The host element to attach the Shadow DOM to.
	 * @param html - The sanitized email HTML to render.
	 */
	function renderEmailHtml(node: HTMLElement, html: string) {
		const shadow = node.attachShadow({ mode: 'closed' });

		/*
		 * Dark mode CSS: when [data-theme="dark"] is on <html>, invert the
		 * entire email body. Double-invert images/video/picture so they
		 * retain their original colors. Also set background to white so the
		 * inversion produces a dark background naturally.
		 */
		/* Use 'sty' + 'le' to avoid Svelte parser interpreting the tag name. */
		const darkModeStyle = document.createElement('sty' + 'le') as HTMLStyleElement;
		darkModeStyle.textContent = [
			':host { display: block; }',
			'.email-wrapper { transition: filter 0.2s; }',
			'.email-wrapper.dark-mode { background: #fff; filter: invert(1) hue-rotate(180deg); }',
			'.email-wrapper.dark-mode img,',
			'.email-wrapper.dark-mode video,',
			'.email-wrapper.dark-mode picture { filter: invert(1) hue-rotate(180deg); }'
		].join('\n');

		/** Wraps the email HTML in a div we can toggle dark mode class on. */
		const wrapper = document.createElement('div');
		wrapper.className = 'email-wrapper';
		wrapper.innerHTML = html;

		/** Applies or removes dark mode class based on current theme. */
		function syncDarkMode() {
			const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
			wrapper.classList.toggle('dark-mode', isDark);
		}

		shadow.appendChild(darkModeStyle);
		shadow.appendChild(wrapper);
		syncDarkMode();

		/*
		 * Watch for theme changes on <html data-theme="..."> so the shadow
		 * DOM updates in real time when the user toggles dark mode.
		 */
		const observer = new MutationObserver(syncDarkMode);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme']
		});

		return {
			update(newHtml: string) {
				wrapper.innerHTML = newHtml;
				syncDarkMode();
			},
			destroy() {
				observer.disconnect();
			}
		};
	}

	// =========================================================================
	// Attachment Helpers
	// =========================================================================

	/**
	 * Formats a file size in bytes to a human-readable string.
	 * @param bytes - The file size in bytes.
	 * @returns Formatted string like "1.2 KB", "3.4 MB", etc.
	 */
	function formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB'];
		const k = 1024;
		const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
		const val = bytes / Math.pow(k, i);
		return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
	}

	/**
	 * Builds the download URL for a single attachment.
	 * Points to our GET /api/thread/[id]/attachment endpoint.
	 *
	 * @param threadId - The Gmail thread ID.
	 * @param att - The attachment info object.
	 * @returns The full URL for downloading the attachment.
	 */
	function attachmentUrl(threadId: string, att: AttachmentInfo): string {
		const params = new URLSearchParams({
			messageId: att.messageId,
			attachmentId: att.attachmentId,
			filename: att.filename,
			mimeType: att.mimeType
		});
		return `/api/thread/${encodeURIComponent(threadId)}/attachment?${params.toString()}`;
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	onMount(async () => {
		/* Fetch user email for the app header (fire-and-forget). */
		fetch('/api/me')
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				if (data?.email) userEmail = data.email;
			})
			.catch(() => {
				/* Silently ignore — header will just not show email. */
			});

		const threadId: string = $page.params.threadId ?? '';

		if (!threadId) {
			errorMessage = 'No thread ID provided.';
			loading = false;
			return;
		}

		/* Step 1: Try loading from cache first (stale-while-revalidate). */
		try {
			const cached = await getCachedThreadDetail(threadId);
			if (cached) {
				thread = cached.data;
				fromCache = true;
				loading = false;
			}
		} catch {
			/* Cache read failed — will fetch from network. */
		}

		/* Step 2: Fetch fresh data if online; otherwise handle offline. */
		if (online.current) {
			await fetchThreadDetail(threadId);
		} else if (!thread) {
			/* Offline and no cache — graceful offline state, not error. */
			loading = false;
			isOfflineNoCache = true;
		} else {
			loading = false;
		}
	});

	onDestroy(() => {
		online.destroy();
	});
</script>

<svelte:head>
	<title>{thread?.subject ?? 'Thread'} - Email Switchboard</title>
</svelte:head>

<div class="app-shell">
	<!-- ── App Header (matches inbox page) ───────────────────────── -->
	<header class="app-header">
		<div class="header-left">
			<a href="/" class="app-name-link">Switchboard</a>
			{#if !online.current}
				<span class="offline-badge" title="You are offline. Some actions are disabled.">
					Offline
				</span>
			{/if}
			{#if fromCache && online.current}
				<span class="cache-badge">Updating...</span>
			{/if}
		</div>
		<div class="header-right">
			<button class="theme-toggle" onclick={toggleTheme} title="Toggle dark mode">
				{#if $theme === 'dark'}
					<!-- Sun icon (switch to light) -->
					<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
						<path
							d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 000-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"
						/>
					</svg>
				{:else}
					<!-- Moon icon (switch to dark) -->
					<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
						<path
							d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 01-4.4 2.26 5.403 5.403 0 01-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"
						/>
					</svg>
				{/if}
			</button>
			{#if userEmail}
				<span class="user-email">{userEmail}</span>
			{/if}
			{#if online.current}
				<a href="/logout" class="sign-out-btn" data-sveltekit-preload-data="off">Sign out</a>
			{/if}
		</div>
	</header>

	<main id="main-content" class="thread-page">
		{#if loading}
			<!-- ── Loading State ──────────────────────────────────────── -->
			<div class="thread-loading">
				<div class="spinner"></div>
				<p>Loading thread...</p>
			</div>
		{:else if isOfflineNoCache}
			<!-- ── Offline with no cache (graceful, not error) ────────── -->
			<div class="thread-offline">
				<svg class="offline-icon" viewBox="0 0 24 24" width="40" height="40" fill="currentColor">
					<path
						d="M24 8.98C20.93 5.9 16.69 4 12 4c-1.21 0-2.4.13-3.55.37l2.07 2.07C11 6.15 11.5 6 12 6c3.87 0 7.39 1.57 9.95 4.11L24 8.98zM2.81 1.63L1.39 3.05l2.07 2.07C1.28 7.08 0 9.95 0 13.12L2.05 15.17C2.03 14.82 2 14.47 2 14.12c0-2.55.93-4.88 2.47-6.67l1.48 1.48C4.73 10.53 4 12.25 4 14.12l2.05 2.05c-.03-.35-.05-.7-.05-1.05 0-2.36.96-4.5 2.51-6.05l1.47 1.47C8.76 11.76 8 12.87 8 14.12l2 2c0-1.1.9-2 2-2 .36 0 .7.1 1 .28l7.95 7.95 1.41-1.41L2.81 1.63z"
					/>
				</svg>
				<h2>You're offline</h2>
				<p>This thread hasn't been cached yet. Connect to the internet to view it.</p>
				<div class="offline-actions">
					<button class="btn" onclick={() => location.reload()}>Try again</button>
					<a href="/" class="btn-secondary-link">Back to inbox</a>
				</div>
			</div>
		{:else if errorMessage}
			<!-- ── Error State ────────────────────────────────────────── -->
			<div class="thread-error">
				<h2>Cannot load thread</h2>
				<p>{errorMessage}</p>
				<div class="error-actions">
					<button class="btn" onclick={() => location.reload()}>Try again</button>
					<a href="/" class="btn-secondary-link">Back to inbox</a>
				</div>
			</div>
		{:else if thread}
			<!-- ── Thread Header ──────────────────────────────────────── -->
			<div class="thread-header">
				<h1 class="thread-subject">{thread.subject}</h1>
				<span class="thread-label-count">
					{thread.messages.length} message{thread.messages.length !== 1 ? 's' : ''}
				</span>
			</div>

			<!-- ── Messages ───────────────────────────────────────────── -->
			<div class="messages">
				{#each thread.messages as msg (msg.id)}
					{@const isExpanded = expandedIds.has(msg.id)}
					<div class="message" class:collapsed={!isExpanded}>
						<div
							class="message-header"
							onclick={() => toggleMessage(msg.id)}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									toggleMessage(msg.id);
								}
							}}
							role="button"
							tabindex="0"
						>
							<div class="message-sender">
								<span class="sender-name">{senderDisplay(msg)}</span>
								{#if isExpanded}
									<span class="sender-email">&lt;{msg.from.email}&gt;</span>
								{/if}
							</div>
							{#if !isExpanded}
								<span class="message-snippet">{decodeHtmlEntities(msg.snippet)}</span>
							{/if}
							<div class="message-meta">
								<span class="message-date">{formatDetailDate(msg.date)}</span>
							</div>
						</div>

						{#if isExpanded}
							{#if msg.to}
								<div class="message-to">
									to {msg.to}
								</div>
							{/if}

							<div class="message-body">
								{#if msg.bodyType === 'html'}
									<!-- Email HTML rendered in a Shadow DOM for CSS isolation + inline display. -->
									<div class="email-html-container" use:renderEmailHtml={msg.body}></div>
								{:else}
									<pre class="text-body">{msg.body || '(No message body)'}</pre>
								{/if}
							</div>

							<!-- ── Attachment Chips ──────────────────────────── -->
							{#if msg.attachments && msg.attachments.length > 0}
								<div class="attachments-section">
									<div class="attachments-label">
										<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
											<path
												d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"
											/>
										</svg>
										{msg.attachments.length} attachment{msg.attachments.length !== 1 ? 's' : ''}
									</div>
									<div class="attachment-chips">
										{#each msg.attachments as att (att.attachmentId)}
											<a
												href={attachmentUrl(thread.id, att)}
												class="attachment-chip"
												download={att.filename}
												title="Download {att.filename} ({formatFileSize(att.size)})"
											>
												<span class="attachment-name">{att.filename}</span>
												<span class="attachment-size">{formatFileSize(att.size)}</span>
											</a>
										{/each}
									</div>
								</div>
							{/if}
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</main>
</div>

<!-- ── Error Toast (background revalidation failures) ──────────── -->
{#if fetchError}
	<div class="error-toast" role="alert">
		<svg class="error-toast-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
			<path
				d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
			/>
		</svg>
		<span class="error-toast-message">{fetchError}</span>
		<button class="error-toast-dismiss" onclick={() => (fetchError = null)} title="Dismiss">
			<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
				<path
					d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
				/>
			</svg>
		</button>
	</div>
{/if}

<style>
	/* ── App Shell ────────────────────────────────────────────────── */
	.app-shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	/* ── App Header (mirrors inbox page header) ──────────────────── */
	.app-header {
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

	.app-name-link {
		font-size: 22px;
		color: var(--color-text-secondary);
		font-weight: 400;
		text-decoration: none;
	}

	.app-name-link:hover {
		color: var(--color-text-primary);
		text-decoration: none;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 16px;
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

	.user-email {
		font-size: 14px;
		color: var(--color-text-secondary);
	}

	.sign-out-btn {
		font-size: 14px;
		color: var(--color-text-secondary);
		padding: 8px 16px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		text-decoration: none;
	}

	.sign-out-btn:hover {
		background: var(--color-bg-hover);
		text-decoration: none;
	}

	/* ── Page Layout ──────────────────────────────────────────────── */
	.thread-page {
		max-width: 900px;
		margin: 0 auto;
		padding: 16px 24px 60px;
		flex: 1;
		background: var(--color-bg-surface);
		width: 100%;
		box-sizing: border-box;
	}

	.offline-badge {
		padding: 4px 12px;
		font-size: 12px;
		font-weight: 500;
		color: var(--color-warning);
		background: var(--color-warning-surface);
		border: 1px solid var(--color-warning-border);
		border-radius: 12px;
		cursor: default;
	}

	.cache-badge {
		padding: 4px 12px;
		font-size: 12px;
		color: var(--color-text-secondary);
		background: var(--color-bg-hover);
		border-radius: 12px;
	}

	/* ── Loading / Error ──────────────────────────────────────────── */
	.thread-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 80px 24px;
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

	/* ── Offline state (graceful, not error) ──────────────────────── */
	.thread-offline {
		text-align: center;
		padding: 80px 24px;
	}

	.offline-icon {
		color: var(--color-text-tertiary);
		margin-bottom: 16px;
	}

	.thread-offline h2 {
		font-size: 18px;
		font-weight: 500;
		color: var(--color-text-primary);
		margin: 0 0 8px;
	}

	.thread-offline p {
		color: var(--color-text-secondary);
		font-size: 14px;
		margin: 0 0 24px;
		line-height: 1.5;
	}

	.offline-actions {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	/* ── Error state ───────────────────────────────────────────────── */
	.thread-error {
		text-align: center;
		padding: 80px 24px;
	}

	.thread-error h2 {
		font-size: 18px;
		font-weight: 500;
		color: var(--color-error);
		margin: 0 0 8px;
	}

	.thread-error p {
		color: var(--color-text-secondary);
		font-size: 14px;
		margin: 0 0 24px;
	}

	.error-actions {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	.btn {
		display: inline-block;
		padding: 8px 24px;
		background: var(--color-primary);
		color: var(--color-tab-badge-text);
		border: none;
		border-radius: 4px;
		font-size: 14px;
		font-weight: 500;
		text-decoration: none;
		cursor: pointer;
		font-family: inherit;
	}

	.btn:hover {
		background: var(--color-primary-hover);
		text-decoration: none;
	}

	.btn-secondary-link {
		font-size: 13px;
		color: var(--color-text-secondary);
		text-decoration: underline;
	}

	.btn-secondary-link:hover {
		color: var(--color-text-primary);
	}

	/* ── Error Toast ──────────────────────────────────────────────── */
	.error-toast {
		position: fixed;
		bottom: 24px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px;
		background: var(--color-error-surface);
		border: 1px solid var(--color-error);
		border-radius: 8px;
		box-shadow: var(--color-shadow-lg);
		z-index: 200;
		max-width: calc(100vw - 32px);
		animation: toast-slide-up 0.3s ease-out;
	}

	.error-toast-icon {
		flex-shrink: 0;
		color: var(--color-error);
	}

	.error-toast-message {
		font-size: 14px;
		color: var(--color-text-primary);
		line-height: 1.4;
	}

	.error-toast-dismiss {
		flex-shrink: 0;
		padding: 4px;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-secondary);
		border-radius: 50%;
		display: flex;
	}

	.error-toast-dismiss:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	@keyframes toast-slide-up {
		from {
			transform: translateX(-50%) translateY(20px);
			opacity: 0;
		}
		to {
			transform: translateX(-50%) translateY(0);
			opacity: 1;
		}
	}

	/* ── Thread Header ────────────────────────────────────────────── */
	.thread-header {
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin-bottom: 20px;
	}

	.thread-subject {
		font-size: 22px;
		font-weight: 400;
		color: var(--color-text-primary);
		margin: 0;
		flex: 1;
		line-height: 1.3;
	}

	.thread-label-count {
		flex-shrink: 0;
		font-size: 13px;
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	/* ── Messages ─────────────────────────────────────────────────── */
	.messages {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.message {
		border: 1px solid var(--color-border-light);
		border-radius: 8px;
		margin-bottom: 8px;
		overflow: hidden;
	}

	.message-header {
		display: flex;
		align-items: center;
		padding: 16px 20px 8px;
		gap: 12px;
		cursor: pointer;
		border-radius: 8px 8px 0 0;
	}

	.message-header:hover {
		background: var(--color-bg-hover);
	}

	.message-sender {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}

	.sender-name {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sender-email {
		font-size: 12px;
		color: var(--color-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.message-meta {
		flex-shrink: 0;
	}

	.message-date {
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.message-to {
		padding: 0 20px 8px;
		font-size: 12px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.message-body {
		padding: 0 20px 20px;
	}

	/* ── Text Body (plain text) ───────────────────────────────────── */
	.text-body {
		font-family: 'Roboto', Arial, sans-serif;
		font-size: 13px;
		line-height: 1.6;
		color: var(--color-text-primary);
		white-space: pre-wrap;
		word-wrap: break-word;
		margin: 0;
		background: none;
		border: none;
		padding: 0;
	}

	/* ── Email HTML Container (Shadow DOM rendering) ─────────────── */
	.email-html-container {
		width: 100%;
		min-height: 20px;
		overflow: auto;
	}

	/* ── Snippet preview (visible when collapsed) ─────────────────── */
	.message-snippet {
		flex: 1;
		font-size: 13px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		padding: 0 8px;
	}

	/* ── Collapsed messages ───────────────────────────────────────── */
	.message.collapsed {
		opacity: 0.7;
	}

	.message.collapsed:hover {
		opacity: 1;
	}

	.message.collapsed .message-header {
		padding-bottom: 16px;
	}

	/* ── Attachments ──────────────────────────────────────────────── */
	.attachments-section {
		padding: 0 20px 16px;
		border-top: 1px solid var(--color-border-subtle);
		margin-top: 8px;
		padding-top: 12px;
	}

	.attachments-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--color-text-secondary);
		margin-bottom: 8px;
	}

	.attachment-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.attachment-chip {
		display: flex;
		flex-direction: column;
		padding: 10px 14px;
		background: var(--color-bg-surface-dim);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		text-decoration: none;
		color: inherit;
		min-width: 120px;
		max-width: 220px;
		transition:
			background 0.15s,
			border-color 0.15s;
	}

	.attachment-chip:hover {
		background: var(--color-bg-hover-alt);
		border-color: var(--color-primary);
		text-decoration: none;
	}

	.attachment-name {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.attachment-size {
		font-size: 11px;
		color: var(--color-text-tertiary);
		margin-top: 2px;
	}
</style>
