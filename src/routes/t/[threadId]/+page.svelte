<!--
  @component Thread Detail Page

  Displays the full content of a single email thread at /t/[threadId].

  Features:
    - Fetches thread detail from GET /api/thread/[id]
    - Shows all messages in the thread with headers and body
    - Renders HTML email bodies in sandboxed iframes for full-fidelity display
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
	import type { ThreadDetail, ThreadDetailMessage } from '$lib/types.js';
	import { getCachedThreadDetail, cacheThreadDetail } from '$lib/cache.js';
	import { createOnlineState } from '$lib/offline.svelte.js';
	import { SvelteSet } from 'svelte/reactivity';

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

	/** Reactive online/offline state. */
	const online = createOnlineState();

	// =========================================================================
	// Data Fetching
	// =========================================================================

	/**
	 * Fetches the thread detail from the API and caches it.
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
				errorMessage = 'Thread not found. It may have been deleted.';
				return;
			}

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				errorMessage = body.message ?? `Failed to load thread (HTTP ${res.status})`;
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
		} catch {
			/*
			 * Network error — if we have cached data, keep showing it.
			 * Otherwise, show an error message.
			 */
			if (!thread) {
				errorMessage = online.current
					? 'Network error. Please try again.'
					: 'This thread is not available offline.';
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
	 * Formats an ISO date for display in the thread detail view.
	 * Shows full date + time (e.g., "Jan 15, 2024 at 3:42 PM").
	 */
	function formatDetailDate(isoDate: string): string {
		if (!isoDate) return '';
		const date = new Date(isoDate);
		if (isNaN(date.getTime())) return isoDate;

		return date.toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			hour12: true
		});
	}

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
	// Iframe Helpers
	// =========================================================================

	/**
	 * Wraps email HTML in a minimal document for iframe srcdoc rendering.
	 *
	 * Adds:
	 *   - `<base target="_blank">` so links open in new tabs
	 *   - Proper charset declaration
	 *   - Body margin reset and hidden overflow (parent iframe auto-sizes)
	 *
	 * @param html - The sanitized email HTML body.
	 * @returns A complete HTML document string for use as iframe srcdoc.
	 */
	function wrapEmailHtml(html: string): string {
		return (
			'<!DOCTYPE html><html><head>' +
			'<base target="_blank">' +
			'<meta charset="utf-8">' +
			'<style>body{margin:0;overflow:hidden;}</style>' +
			'</head><body>' +
			html +
			'</body></html>'
		);
	}

	/**
	 * Handles iframe load event by auto-sizing to fit content
	 * and observing for future size changes (e.g., images loading).
	 */
	function handleIframeLoad(e: Event): void {
		const iframe = e.target as HTMLIFrameElement;
		const doc = iframe.contentDocument;
		if (!doc) return;

		/** Updates the iframe height to match its content. */
		const updateHeight = () => {
			const height = doc.documentElement.scrollHeight;
			iframe.style.height = height + 'px';
		};

		updateHeight();

		/* Watch for size changes (images loading, lazy content, etc.). */
		const observer = new ResizeObserver(updateHeight);
		observer.observe(doc.body);
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	onMount(async () => {
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

		/* Step 2: Fetch fresh data if online. */
		if (online.current) {
			await fetchThreadDetail(threadId);
		} else if (!thread) {
			/* Offline and no cache — show message. */
			loading = false;
			errorMessage = 'This thread is not available offline.';
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

<main class="thread-page">
	<!-- ── Navigation Bar ───────────────────────────────────────── -->
	<nav class="thread-nav">
		<a href="/" class="back-link">
			<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
				<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
			</svg>
			Back to inbox
		</a>

		{#if !online.current}
			<span class="offline-badge" title="You are offline. Some actions are disabled.">
				Offline
			</span>
		{/if}

		{#if fromCache && online.current}
			<span class="cache-badge">Updating...</span>
		{/if}
	</nav>

	{#if loading}
		<!-- ── Loading State ──────────────────────────────────────── -->
		<div class="thread-loading">
			<div class="spinner"></div>
			<p>Loading thread...</p>
		</div>
	{:else if errorMessage}
		<!-- ── Error State ────────────────────────────────────────── -->
		<div class="thread-error">
			<h2>Cannot load thread</h2>
			<p>{errorMessage}</p>
			<a href="/" class="btn">Back to inbox</a>
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
							<span class="message-snippet">{msg.snippet}</span>
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
								<!-- Email HTML rendered in a sandboxed iframe for full-fidelity display. -->
								<iframe
									srcdoc={wrapEmailHtml(msg.body)}
									sandbox="allow-same-origin allow-popups"
									class="email-iframe"
									onload={handleIframeLoad}
									title="Email content from {senderDisplay(msg)}"
								></iframe>
							{:else}
								<pre class="text-body">{msg.body || '(No message body)'}</pre>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</main>

<style>
	/* ── Page Layout ──────────────────────────────────────────────── */
	.thread-page {
		max-width: 900px;
		margin: 0 auto;
		padding: 16px 24px 60px;
		min-height: 100vh;
		background: var(--color-bg-surface);
	}

	/* ── Navigation ───────────────────────────────────────────────── */
	.thread-nav {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 20px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--color-border-light);
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

	.offline-badge {
		margin-left: auto;
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
		margin-left: auto;
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

	.btn {
		display: inline-block;
		padding: 8px 24px;
		background: var(--color-primary);
		color: var(--color-tab-badge-text);
		border-radius: 4px;
		font-size: 14px;
		font-weight: 500;
		text-decoration: none;
	}

	.btn:hover {
		background: var(--color-primary-hover);
		text-decoration: none;
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
		font-family: 'Roboto Mono', monospace;
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

	/* ── Email Iframe (sandboxed HTML rendering) ─────────────────── */
	.email-iframe {
		width: 100%;
		border: none;
		min-height: 80px;
		display: block;
		/* Height is set dynamically by handleIframeLoad(). */
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
</style>
