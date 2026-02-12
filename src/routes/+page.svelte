<!--
  @component Inbox Page

  The main inbox view after authentication. Features:
    - Four configurable panels (tabs) for sorting threads
    - Gmail-like thread list with checkbox, sender, subject, snippet, date
    - Panel configuration modal for naming panels and setting regex rules
    - Two-phase thread fetching (list → batch metadata) to minimize API calls
    - Panel config persisted to localStorage

  Data flow:
    1. On mount: check auth via /api/me
    2. Fetch thread IDs via GET /api/threads
    3. Batch fetch metadata via POST /api/threads/metadata
    4. Sort threads into panels using the rule engine
    5. Display the active panel's threads
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { theme, toggleTheme } from '$lib/stores/theme';
	import type {
		ThreadMetadata,
		PanelConfig,
		ThreadsListApiResponse,
		ThreadsMetadataApiResponse
	} from '$lib/types.js';
	import { assignPanel, getDefaultPanels } from '$lib/rules.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { createOnlineState } from '$lib/offline.svelte.js';
	import { cacheThreadMetadata, getAllCachedMetadata } from '$lib/cache.js';
	import { formatListDate, decodeHtmlEntities } from '$lib/format.js';

	// =========================================================================
	// State
	// =========================================================================

	/** The authenticated user's email address. */
	let email: string | null = $state(null);

	/** Whether the initial auth check is in progress. */
	let loading: boolean = $state(true);

	/** Error message if auth or initial fetch failed. */
	let errorMessage: string | null = $state(null);

	/** Full metadata for all fetched threads. */
	let threadMetaList: ThreadMetadata[] = $state([]);

	/** Pagination token for loading more threads. */
	let nextPageToken: string | undefined = $state(undefined);

	/** Whether threads are currently being fetched. */
	let loadingThreads: boolean = $state(false);

	/** Panel configurations (loaded from localStorage). */
	let panels: PanelConfig[] = $state(getDefaultPanels());

	/** Index of the currently active panel tab. */
	let activePanel: number = $state(0);

	/** Set of selected thread IDs (for future bulk actions). Uses SvelteSet for reactivity. */
	let selectedThreads = new SvelteSet<string>();

	/** Whether the panel config modal is open. */
	let showConfig: boolean = $state(false);

	/** Temporary copy of panels being edited in the config modal. */
	let editingPanels: PanelConfig[] = $state([]);

	/** Which panel is selected in the config modal editor. */
	let editingPanelIndex: number = $state(0);

	/** Whether the pattern help section is expanded (in config modal). */
	let showPatternHelp: boolean = $state(false);

	/** Whether the onboarding wizard is showing. */
	let showOnboarding: boolean = $state(false);

	/** Current step in the onboarding wizard (0 = Welcome, 1 = Setup, 2 = Done). */
	let onboardingStep: number = $state(0);

	/** Reactive online/offline state. */
	const online = createOnlineState();

	/** Whether all server threads have been fetched (no more pagination tokens). */
	let allThreadsLoaded: boolean = $state(false);

	/** Counter for consecutive auto-fill fetches to prevent infinite loops. */
	let autoFillCount: number = $state(0);

	// =========================================================================
	// Constants
	// =========================================================================

	/** localStorage key for persisting panel configurations. */
	const PANELS_STORAGE_KEY = 'switchboard_panels';

	/** Minimum threads per panel before auto-fill triggers. */
	const MIN_PANEL_THREADS = 15;

	/** Maximum consecutive auto-fill fetches to prevent API hammering. */
	const MAX_AUTO_FILL = 5;

	// =========================================================================
	// Derived Values
	// =========================================================================

	/**
	 * Reconstructs the raw From header string from parsed parts.
	 * Needed for rule matching, which operates on the raw header value.
	 */
	function reconstructFrom(thread: ThreadMetadata): string {
		if (thread.from.name) {
			return `${thread.from.name} <${thread.from.email}>`;
		}
		return thread.from.email;
	}

	/**
	 * Per-panel statistics: total thread count and unread count.
	 * Computed in a single pass over all threads for efficiency.
	 */
	let panelStats = $derived.by(() => {
		const stats = panels.map(() => ({ total: 0, unread: 0 }));
		for (const thread of threadMetaList) {
			const fromRaw = reconstructFrom(thread);
			const idx = assignPanel(panels, fromRaw, thread.to);
			if (idx >= 0 && idx < stats.length) {
				stats[idx].total++;
				if (thread.labelIds.includes('UNREAD')) stats[idx].unread++;
			}
		}
		return stats;
	});

	/** Threads belonging to the currently active panel, sorted by date (newest first). */
	let currentPanelThreads = $derived.by(() => {
		const filtered = threadMetaList.filter((thread) => {
			const fromRaw = reconstructFrom(thread);
			return assignPanel(panels, fromRaw, thread.to) === activePanel;
		});
		/* Sort by date descending (newest first). */
		filtered.sort((a, b) => {
			const da = a.date ? new Date(a.date).getTime() : 0;
			const db = b.date ? new Date(b.date).getTime() : 0;
			return db - da;
		});
		return filtered;
	});

	// =========================================================================
	// localStorage Helpers
	// =========================================================================

	/**
	 * Loads panel configuration from localStorage.
	 * Falls back to defaults if nothing is stored or the data is corrupted.
	 */
	function loadPanels(): PanelConfig[] {
		try {
			const saved = localStorage.getItem(PANELS_STORAGE_KEY);
			if (saved) {
				const parsed = JSON.parse(saved) as PanelConfig[];
				if (Array.isArray(parsed) && parsed.length > 0) {
					return parsed;
				}
			}
		} catch {
			/* Corrupted localStorage data — fall back to defaults. */
		}
		return getDefaultPanels();
	}

	/**
	 * Returns true if the user has never saved panel config (first-time user).
	 * Used to trigger the onboarding wizard.
	 */
	function isFirstTimeUser(): boolean {
		return localStorage.getItem(PANELS_STORAGE_KEY) === null;
	}

	/** Persists panel configuration to localStorage. */
	function savePanels(p: PanelConfig[]): void {
		try {
			localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(p));
		} catch {
			/* localStorage full or unavailable — silently ignore. */
		}
	}

	// =========================================================================
	// Data Fetching
	// =========================================================================

	/**
	 * Fetches threads using the two-phase pattern:
	 *   1. GET /api/threads → thread IDs + snippets
	 *   2. POST /api/threads/metadata → full headers for those IDs
	 *
	 * After a successful fetch, caches metadata to IndexedDB for offline access.
	 * On network error when offline, falls back to cached data.
	 *
	 * @param pageToken - Pagination token for loading more threads.
	 */
	async function fetchInbox(pageToken?: string): Promise<void> {
		loadingThreads = true;

		/* On a full refresh (no pageToken), reset exhaustion state. */
		if (!pageToken) {
			allThreadsLoaded = false;
		}

		try {
			/* Phase 1: Get thread IDs. */
			const listUrl = pageToken
				? `/api/threads?pageToken=${encodeURIComponent(pageToken)}`
				: '/api/threads';

			const listRes = await fetch(listUrl);

			if (listRes.status === 401) {
				goto('/login');
				return;
			}

			if (!listRes.ok) {
				const body = await listRes.json().catch(() => ({}));
				errorMessage = body.message ?? `Failed to load threads (HTTP ${listRes.status})`;
				return;
			}

			const listData: ThreadsListApiResponse = await listRes.json();
			nextPageToken = listData.nextPageToken;

			/* Mark pagination as exhausted when no more pages. */
			if (!listData.nextPageToken) {
				allThreadsLoaded = true;
			}

			if (listData.threads.length === 0) {
				return;
			}

			/* Phase 2: Batch fetch metadata for all thread IDs. */
			const ids = listData.threads.map((t) => t.id);
			const metaRes = await fetch('/api/threads/metadata', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids })
			});

			if (metaRes.status === 401) {
				goto('/login');
				return;
			}

			if (!metaRes.ok) {
				const body = await metaRes.json().catch(() => ({}));
				errorMessage = body.message ?? `Failed to load thread details (HTTP ${metaRes.status})`;
				return;
			}

			const metaData: ThreadsMetadataApiResponse = await metaRes.json();

			if (pageToken) {
				/* Append to existing threads (pagination). */
				threadMetaList = [...threadMetaList, ...metaData.threads];
			} else {
				/* Replace threads (initial load or refresh). */
				threadMetaList = metaData.threads;
			}

			/* Cache the fetched metadata to IndexedDB for offline access. */
			try {
				await cacheThreadMetadata(metaData.threads);
			} catch {
				/* Cache write failed — non-critical, just skip. */
			}
		} catch (err) {
			/*
			 * Network error — if offline, try loading from IndexedDB cache.
			 * Otherwise, show the error message.
			 */
			if (!online.current && threadMetaList.length === 0) {
				try {
					const cached = await getAllCachedMetadata();
					if (cached.length > 0) {
						threadMetaList = cached.map((c) => c.data);
						allThreadsLoaded = true;
						return;
					}
				} catch {
					/* Cache read also failed — fall through to error. */
				}
			}

			/* Only show error if we have no data to display. */
			if (threadMetaList.length === 0) {
				errorMessage = online.current
					? err instanceof Error
						? err.message
						: 'Network error'
					: 'You are offline. No cached emails available.';
			}
		} finally {
			loadingThreads = false;
		}
	}

	// =========================================================================
	// UI Helpers
	// =========================================================================

	/** Toggles thread selection for the given ID. */
	function toggleThread(id: string): void {
		if (selectedThreads.has(id)) {
			selectedThreads.delete(id);
		} else {
			selectedThreads.add(id);
		}
	}

	/** Returns the display name for a thread's sender. */
	function senderDisplay(thread: ThreadMetadata): string {
		if (thread.from.name) return thread.from.name;
		/* Show the part before @ if no display name. */
		const atIdx = thread.from.email.indexOf('@');
		return atIdx > 0 ? thread.from.email.slice(0, atIdx) : thread.from.email;
	}

	// =========================================================================
	// Auto-Fill Logic
	// =========================================================================

	/**
	 * Automatically loads more threads if the active panel has fewer than
	 * MIN_PANEL_THREADS visible threads and the server has more to fetch.
	 *
	 * Called after initial load and after panel switches. Limits consecutive
	 * fetches to MAX_AUTO_FILL to prevent infinite API hammering when a
	 * panel's rules don't match any incoming threads.
	 */
	async function maybeAutoFill(): Promise<void> {
		while (
			!allThreadsLoaded &&
			!loadingThreads &&
			autoFillCount < MAX_AUTO_FILL &&
			nextPageToken &&
			currentPanelThreads.length < MIN_PANEL_THREADS
		) {
			autoFillCount++;
			await fetchInbox(nextPageToken);
		}
	}

	/**
	 * Switches to a different panel tab.
	 *
	 * @param index - The panel index to switch to.
	 */
	function switchPanel(index: number): void {
		activePanel = index;
	}

	// =========================================================================
	// Config Modal
	// =========================================================================

	/** Opens the panel config modal with a deep clone of current panels. */
	function openConfig(): void {
		editingPanels = JSON.parse(JSON.stringify(panels));
		editingPanelIndex = 0;
		showConfig = true;
	}

	/** Saves the edited panel config and closes the modal. */
	function saveConfig(): void {
		panels = JSON.parse(JSON.stringify(editingPanels));
		savePanels(panels);
		/* Ensure activePanel doesn't exceed new panel count. */
		if (activePanel >= panels.length) {
			activePanel = panels.length - 1;
		}
		showConfig = false;
	}

	/** Closes the config modal without saving. */
	function cancelConfig(): void {
		showConfig = false;
	}

	/** Maximum number of panels allowed. */
	const MAX_PANELS = 4;

	/** Adds a new panel (up to MAX_PANELS). */
	function addPanel(): void {
		if (editingPanels.length >= MAX_PANELS) return;
		editingPanels = [...editingPanels, { name: `Panel ${editingPanels.length + 1}`, rules: [] }];
		editingPanelIndex = editingPanels.length - 1;
	}

	/** Removes a panel at the given index (minimum 1 panel). */
	function removePanel(index: number): void {
		if (editingPanels.length <= 1) return;
		editingPanels = editingPanels.filter((_, i) => i !== index);
		/* Adjust selected panel index if needed. */
		if (editingPanelIndex >= editingPanels.length) {
			editingPanelIndex = editingPanels.length - 1;
		}
	}

	/** Adds a new empty rule to the panel being edited. */
	function addRule(): void {
		editingPanels[editingPanelIndex].rules = [
			...editingPanels[editingPanelIndex].rules,
			{ field: 'from', pattern: '', action: 'accept' }
		];
	}

	/** Removes a rule at the given index from the panel being edited. */
	function removeRule(ruleIndex: number): void {
		editingPanels[editingPanelIndex].rules = editingPanels[editingPanelIndex].rules.filter(
			(_, i) => i !== ruleIndex
		);
	}

	// =========================================================================
	// Onboarding Wizard
	// =========================================================================

	/** Starts the onboarding wizard with a single empty "Primary" panel. */
	function startOnboarding(): void {
		editingPanels = [{ name: 'Primary', rules: [] }];
		editingPanelIndex = 0;
		onboardingStep = 0;
		showOnboarding = true;
	}

	/** Advances to the next onboarding step. */
	function nextOnboardingStep(): void {
		onboardingStep++;
	}

	/** Goes back to the previous onboarding step. */
	function prevOnboardingStep(): void {
		if (onboardingStep > 0) onboardingStep--;
	}

	/** Finishes onboarding: saves panels and fetches inbox. */
	async function finishOnboarding(): Promise<void> {
		panels = JSON.parse(JSON.stringify(editingPanels));
		savePanels(panels);
		showOnboarding = false;
		await fetchInbox();
		await maybeAutoFill();
	}

	/** Skips onboarding: saves a single catch-all "Inbox" panel. */
	async function skipOnboarding(): Promise<void> {
		panels = [{ name: 'Inbox', rules: [] }];
		savePanels(panels);
		showOnboarding = false;
		await fetchInbox();
		await maybeAutoFill();
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	onMount(async () => {
		/* Load saved panel config from localStorage. */
		panels = loadPanels();

		/* Check authentication. */
		try {
			const res = await fetch('/api/me');

			if (res.status === 401) {
				goto('/login');
				return;
			}

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				errorMessage = body.message ?? body.error ?? `HTTP ${res.status}`;
				loading = false;
				return;
			}

			const data: { email: string } = await res.json();
			email = data.email;
		} catch (err) {
			/*
			 * Network error on auth check — if offline, try loading cached
			 * threads so the user can at least browse previously loaded emails.
			 */
			if (!online.current) {
				try {
					const cached = await getAllCachedMetadata();
					if (cached.length > 0) {
						threadMetaList = cached.map((c) => c.data);
						allThreadsLoaded = true;
						email = '(Offline)';
						loading = false;
						return;
					}
				} catch {
					/* Cache read failed — fall through to error. */
				}
			}

			errorMessage = err instanceof Error ? err.message : 'Network error';
			loading = false;
			return;
		}

		loading = false;

		/* Show onboarding wizard for first-time users. */
		if (isFirstTimeUser()) {
			startOnboarding();
			return;
		}

		/*
		 * Stale-while-revalidate: show cached threads instantly, then
		 * fetch fresh data in the background (matches thread detail pattern).
		 */
		try {
			const cached = await getAllCachedMetadata();
			if (cached.length > 0) {
				threadMetaList = cached.map((c) => c.data);
			}
		} catch {
			/* Cache read failed — will fetch from network below. */
		}

		if (online.current) {
			await fetchInbox();
			await maybeAutoFill();
		} else if (threadMetaList.length > 0) {
			/* Offline but cache was loaded — skip fetch, mark as complete. */
			allThreadsLoaded = true;
		}
	});

	onDestroy(() => {
		online.destroy();
	});
</script>

<svelte:head>
	<title>Inbox - Email Switchboard</title>
</svelte:head>

{#if loading}
	<!-- ── Full-page loading spinner (auth check) ──────────────────── -->
	<main class="loading-page">
		<div class="loading-content">
			<div class="spinner"></div>
			<p>Loading…</p>
		</div>
	</main>
{:else if errorMessage}
	<!-- ── Error state ─────────────────────────────────────────────── -->
	<main class="error-page">
		<div class="error-card">
			<h2>Something went wrong</h2>
			<p>{errorMessage}</p>
			<a href="/login" class="btn">Sign in again</a>
		</div>
	</main>
{:else if email}
	<!-- ── Authenticated inbox view ────────────────────────────────── -->
	<div class="app-shell">
		<!-- ── App Header ──────────────────────────────────────────── -->
		<header class="app-header">
			<div class="header-left">
				<span class="app-name">Switchboard</span>
				{#if !online.current}
					<span class="offline-badge" title="You are offline. Some actions are disabled.">
						Offline
					</span>
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
				<span class="user-email">{email}</span>
				{#if online.current}
					<a href="/logout" class="sign-out-btn" data-sveltekit-preload-data="off">Sign out</a>
				{/if}
			</div>
		</header>

		<!-- ── Panel Tabs ──────────────────────────────────────────── -->
		<nav class="panel-tabs">
			{#each panels as panel, i (i)}
				<button class="panel-tab" class:active={activePanel === i} onclick={() => switchPanel(i)}>
					<span class="tab-name">{panel.name}</span>
					{#if panelStats[i]?.unread > 0}
						<span class="tab-badge">{panelStats[i].unread}</span>
					{/if}
				</button>
			{/each}

			<button class="config-btn" onclick={openConfig} title="Configure panels">
				<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
					<path
						d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z"
					/>
				</svg>
			</button>
		</nav>

		<!-- ── Thread List ─────────────────────────────────────────── -->
		<main class="thread-area">
			{#if loadingThreads && threadMetaList.length === 0}
				<!-- Loading threads -->
				<div class="threads-loading">
					<div class="spinner small"></div>
					<p>Loading threads…</p>
				</div>
			{:else if currentPanelThreads.length === 0}
				<!-- Empty panel -->
				<div class="empty-panel">
					<p>No threads in <strong>{panels[activePanel]?.name ?? 'this panel'}</strong>.</p>
					<p class="empty-hint">
						{#if threadMetaList.length === 0}
							Your inbox is empty.
						{:else}
							Try adjusting your panel rules to sort threads here.
						{/if}
					</p>
				</div>
			{:else}
				<!-- Thread rows -->
				<div class="thread-list">
					{#each currentPanelThreads as thread (thread.id)}
						<div class="thread-row" class:unread={thread.labelIds.includes('UNREAD')}>
							<label class="thread-checkbox">
								<input
									type="checkbox"
									checked={selectedThreads.has(thread.id)}
									onchange={() => toggleThread(thread.id)}
								/>
							</label>

							<a href="/t/{thread.id}" class="thread-link">
								<span class="thread-from">{senderDisplay(thread)}</span>
								<span class="thread-content">
									<span class="thread-subject">{thread.subject}</span>
									{#if thread.snippet}
										<span class="thread-snippet"> – {decodeHtmlEntities(thread.snippet)}</span>
									{/if}
								</span>
								{#if thread.messageCount > 1}
									<span class="thread-count">{thread.messageCount}</span>
								{/if}
								<span class="thread-date">{formatListDate(thread.date)}</span>
							</a>
						</div>
					{/each}
				</div>

				<!-- Load more / All loaded indicator -->
				{#if loadingThreads}
					<div class="load-more">
						<div class="spinner small"></div>
						<span class="load-more-text">Loading more threads…</span>
					</div>
				{:else if nextPageToken && !allThreadsLoaded}
					<div class="load-more">
						<button
							class="load-more-btn"
							disabled={!online.current}
							onclick={() => fetchInbox(nextPageToken)}
							title={!online.current ? 'Cannot load more while offline' : ''}
						>
							{!online.current ? 'Offline — cannot load more' : 'Load more threads'}
						</button>
					</div>
				{:else if allThreadsLoaded}
					<div class="all-loaded">
						<span class="all-loaded-text">All emails loaded</span>
					</div>
				{/if}
			{/if}
		</main>
	</div>

	<!-- ── Panel Config Modal ──────────────────────────────────────── -->
	{#if showConfig}
		<div class="modal-backdrop" onclick={cancelConfig} role="presentation">
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="modal" onclick={(e) => e.stopPropagation()}>
				<div class="modal-header">
					<h2>Configure Panels</h2>
					<button class="modal-close" onclick={cancelConfig} title="Close">
						<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
							<path
								d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
							/>
						</svg>
					</button>
				</div>

				<!-- Panel selector tabs within the modal -->
				<div class="config-tabs">
					{#each editingPanels as panel, i (i)}
						<div class="config-tab-wrapper">
							<button
								class="config-tab"
								class:active={editingPanelIndex === i}
								onclick={() => (editingPanelIndex = i)}
							>
								{panel.name || `Panel ${i + 1}`}
							</button>
							{#if editingPanels.length > 1}
								<button class="tab-remove" onclick={() => removePanel(i)} title="Remove panel">
									&times;
								</button>
							{/if}
						</div>
					{/each}
					{#if editingPanels.length < MAX_PANELS}
						<button class="config-tab add-tab" onclick={addPanel} title="Add panel"> + </button>
					{/if}
				</div>

				<!-- Edit the selected panel -->
				{#if editingPanels[editingPanelIndex]}
					<div class="config-body">
						<!-- Panel name -->
						<div class="config-field">
							<label class="config-label" for="panel-name">Panel Name</label>
							<input
								id="panel-name"
								type="text"
								class="config-input"
								bind:value={editingPanels[editingPanelIndex].name}
								placeholder="e.g., Work, Social, Updates"
							/>
						</div>

						<!-- Rules -->
						<div class="config-rules">
							<h3 class="rules-heading">
								Rules
								<span class="rules-hint">First matching rule wins</span>
							</h3>

							{#if editingPanels[editingPanelIndex].rules.length === 0}
								<p class="no-rules">
									No rules — threads won't be sorted into this panel
									{#if editingPanelIndex === editingPanels.length - 1}
										(catch-all for unmatched threads)
									{/if}.
								</p>
							{/if}

							{#each editingPanels[editingPanelIndex].rules as rule, ri (ri)}
								<div class="rule-card">
									<div class="rule-card-header">
										<span class="rule-label">Rule {ri + 1}</span>
										<button class="rule-remove" onclick={() => removeRule(ri)} title="Remove rule">
											<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
												<path
													d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
												/>
											</svg>
										</button>
									</div>

									<div class="rule-field">
										<label class="rule-field-label" for="rule-field-{ri}">
											When <strong>{rule.field === 'from' ? 'From' : 'To'}</strong> matches...
										</label>
										<select class="rule-select" id="rule-field-{ri}" bind:value={rule.field}>
											<option value="from">From</option>
											<option value="to">To</option>
										</select>
									</div>

									<div class="rule-field">
										<label class="rule-field-label" for="rule-pattern-{ri}">Pattern</label>
										<input
											type="text"
											id="rule-pattern-{ri}"
											class="rule-pattern"
											bind:value={rule.pattern}
											placeholder="e.g., @company\.com or newsletter|digest"
										/>
									</div>

									<div class="rule-field">
										<label class="rule-field-label" for="rule-action-{ri}">
											Then <strong>{rule.action === 'accept' ? 'Accept' : 'Reject'}</strong>
										</label>
										<select class="rule-select" id="rule-action-{ri}" bind:value={rule.action}>
											<option value="accept">Accept</option>
											<option value="reject">Reject</option>
										</select>
									</div>
								</div>
							{/each}

							<button class="add-rule-btn" onclick={addRule}>
								<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
									<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
								</svg>
								Add rule
							</button>
						</div>

						<!-- Catch-all description -->
						<p class="catchall-hint">
							The last panel is a catch-all for emails that don't match any other panel's rules.
						</p>

						<!-- Regex / Pattern Help (collapsible) -->
						<div class="pattern-help">
							<button
								class="pattern-help-toggle"
								onclick={() => (showPatternHelp = !showPatternHelp)}
							>
								{showPatternHelp ? 'Hide' : 'Need help with'} patterns?
								<svg
									viewBox="0 0 24 24"
									width="16"
									height="16"
									fill="currentColor"
									class="chevron"
									class:expanded={showPatternHelp}
								>
									<path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
								</svg>
							</button>
							{#if showPatternHelp}
								<div class="pattern-help-body">
									<table class="pattern-table">
										<thead>
											<tr>
												<th>Pattern</th>
												<th>What it matches</th>
											</tr>
										</thead>
										<tbody>
											<tr>
												<td><code>@company\.com</code></td>
												<td>All emails from company.com</td>
											</tr>
											<tr>
												<td><code>@(twitter|facebook)\.com</code></td>
												<td>Multiple domains</td>
											</tr>
											<tr>
												<td><code>newsletter|digest</code></td>
												<td>Emails containing keywords</td>
											</tr>
											<tr>
												<td><code>john@example\.com</code></td>
												<td>A specific email address</td>
											</tr>
											<tr>
												<td><code>no-reply</code></td>
												<td>Emails containing "no-reply"</td>
											</tr>
										</tbody>
									</table>
									<p class="pattern-note">
										Patterns are case-insensitive and match anywhere in the email address. Use <code
											>\.</code
										>
										for literal dots. Use <code>|</code> to match multiple alternatives.
									</p>
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<div class="modal-footer">
					<button class="btn-secondary" onclick={cancelConfig}>Cancel</button>
					<button class="btn-primary" onclick={saveConfig}>Save</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- ── Onboarding Wizard Modal ────────────────────────────────── -->
	{#if showOnboarding}
		<div class="modal-backdrop" role="presentation">
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="modal onboarding-modal" onclick={(e) => e.stopPropagation()}>
				{#if onboardingStep === 0}
					<!-- Step 1: Welcome -->
					<div class="onboarding-welcome">
						<h2>Welcome to Switchboard</h2>
						<p class="onboarding-desc">
							Panels let you sort your inbox using rules. Emails matching a panel's rules appear in
							that tab. The last panel catches everything else.
						</p>
						<div class="onboarding-actions">
							<button class="btn-primary" onclick={nextOnboardingStep}>Set up panels</button>
							<button class="btn-link" onclick={skipOnboarding}>Skip setup</button>
						</div>
					</div>
				{:else if onboardingStep === 1}
					<!-- Step 2: Panel Setup (reuses config body) -->
					<div class="modal-header">
						<h2>Set Up Your Panels</h2>
					</div>

					<div class="config-tabs">
						{#each editingPanels as panel, i (i)}
							<div class="config-tab-wrapper">
								<button
									class="config-tab"
									class:active={editingPanelIndex === i}
									onclick={() => (editingPanelIndex = i)}
								>
									{panel.name || `Panel ${i + 1}`}
								</button>
								{#if editingPanels.length > 1}
									<button class="tab-remove" onclick={() => removePanel(i)} title="Remove panel">
										&times;
									</button>
								{/if}
							</div>
						{/each}
						{#if editingPanels.length < MAX_PANELS}
							<button class="config-tab add-tab" onclick={addPanel} title="Add panel"> + </button>
						{/if}
					</div>

					{#if editingPanels[editingPanelIndex]}
						<div class="config-body">
							<div class="config-field">
								<label class="config-label" for="onboard-panel-name">Panel Name</label>
								<input
									id="onboard-panel-name"
									type="text"
									class="config-input"
									bind:value={editingPanels[editingPanelIndex].name}
									placeholder="e.g., Work, Social, Updates"
								/>
							</div>

							<div class="config-rules">
								<h3 class="rules-heading">
									Rules
									<span class="rules-hint">First matching rule wins</span>
								</h3>

								{#if editingPanels[editingPanelIndex].rules.length === 0}
									<p class="no-rules">
										No rules — threads won't be sorted into this panel
										{#if editingPanelIndex === editingPanels.length - 1}
											(catch-all for unmatched threads)
										{/if}.
									</p>
								{/if}

								{#each editingPanels[editingPanelIndex].rules as rule, ri (ri)}
									<div class="rule-card">
										<div class="rule-card-header">
											<span class="rule-label">Rule {ri + 1}</span>
											<button
												class="rule-remove"
												onclick={() => removeRule(ri)}
												title="Remove rule"
											>
												<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
													<path
														d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
													/>
												</svg>
											</button>
										</div>

										<div class="rule-field">
											<label class="rule-field-label" for="onboard-rule-field-{ri}">
												When <strong>{rule.field === 'from' ? 'From' : 'To'}</strong> matches...
											</label>
											<select
												class="rule-select"
												id="onboard-rule-field-{ri}"
												bind:value={rule.field}
											>
												<option value="from">From</option>
												<option value="to">To</option>
											</select>
										</div>

										<div class="rule-field">
											<label class="rule-field-label" for="onboard-rule-pattern-{ri}">
												Pattern
											</label>
											<input
												type="text"
												id="onboard-rule-pattern-{ri}"
												class="rule-pattern"
												bind:value={rule.pattern}
												placeholder="e.g., @company\.com or newsletter|digest"
											/>
										</div>

										<div class="rule-field">
											<label class="rule-field-label" for="onboard-rule-action-{ri}">
												Then <strong>{rule.action === 'accept' ? 'Accept' : 'Reject'}</strong>
											</label>
											<select
												class="rule-select"
												id="onboard-rule-action-{ri}"
												bind:value={rule.action}
											>
												<option value="accept">Accept</option>
												<option value="reject">Reject</option>
											</select>
										</div>
									</div>
								{/each}

								<button class="add-rule-btn" onclick={addRule}>
									<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
										<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
									</svg>
									Add rule
								</button>
							</div>

							<p class="catchall-hint">
								The last panel is a catch-all for emails that don't match any other panel's rules.
							</p>

							<!-- Pattern help is always expanded in onboarding -->
							<div class="pattern-help">
								<div class="pattern-help-body">
									<h4 class="pattern-help-title">Pattern Help</h4>
									<table class="pattern-table">
										<thead>
											<tr>
												<th>Pattern</th>
												<th>What it matches</th>
											</tr>
										</thead>
										<tbody>
											<tr>
												<td><code>@company\.com</code></td>
												<td>All emails from company.com</td>
											</tr>
											<tr>
												<td><code>@(twitter|facebook)\.com</code></td>
												<td>Multiple domains</td>
											</tr>
											<tr>
												<td><code>newsletter|digest</code></td>
												<td>Emails containing keywords</td>
											</tr>
											<tr>
												<td><code>john@example\.com</code></td>
												<td>A specific email address</td>
											</tr>
											<tr>
												<td><code>no-reply</code></td>
												<td>Emails containing "no-reply"</td>
											</tr>
										</tbody>
									</table>
									<p class="pattern-note">
										Patterns are case-insensitive and match anywhere in the email address. Use <code
											>\.</code
										>
										for literal dots. Use <code>|</code> to match multiple alternatives.
									</p>
								</div>
							</div>
						</div>
					{/if}

					<div class="modal-footer">
						<button class="btn-secondary" onclick={prevOnboardingStep}>Back</button>
						<div class="footer-right">
							<button class="btn-link" onclick={skipOnboarding}>Skip setup</button>
							<button class="btn-primary" onclick={nextOnboardingStep}>Next</button>
						</div>
					</div>
				{:else}
					<!-- Step 3: Done -->
					<div class="onboarding-welcome">
						<h2>You're all set!</h2>
						<p class="onboarding-desc">
							Your panels are ready. You can always change them later using the gear icon.
						</p>
						<div class="onboarding-actions">
							<button class="btn-primary" onclick={finishOnboarding}>Start using Switchboard</button
							>
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
{/if}

<style>
	/* ── Loading state ─────────────────────────────────────────────── */
	.loading-page {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
	}

	.loading-content {
		text-align: center;
		color: var(--color-text-secondary);
	}

	.spinner {
		width: 40px;
		height: 40px;
		border: 3px solid var(--color-border);
		border-top-color: var(--color-primary);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
		margin: 0 auto 16px;
	}

	.spinner.small {
		width: 24px;
		height: 24px;
		border-width: 2px;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ── Error state ───────────────────────────────────────────────── */
	.error-page {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
	}

	.error-card {
		background: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 40px;
		text-align: center;
		max-width: 400px;
	}

	.error-card h2 {
		margin: 0 0 8px;
		font-size: 18px;
		font-weight: 500;
		color: var(--color-error);
	}

	.error-card p {
		color: var(--color-text-secondary);
		margin: 0 0 24px;
		font-size: 14px;
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

	/* ── App shell ─────────────────────────────────────────────────── */
	.app-shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	/* ── App Header ────────────────────────────────────────────────── */
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

	.app-name {
		font-size: 22px;
		color: var(--color-text-secondary);
		font-weight: 400;
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

	/* ── Panel Tabs ────────────────────────────────────────────────── */
	.panel-tabs {
		display: flex;
		align-items: center;
		background: var(--color-bg-surface);
		border-bottom: 1px solid var(--color-border);
		padding: 0 8px;
		gap: 0;
	}

	.panel-tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 14px 20px;
		font-size: 14px;
		color: var(--color-text-secondary);
		background: none;
		border: none;
		border-bottom: 3px solid transparent;
		cursor: pointer;
		font-family: inherit;
		transition:
			color 0.15s,
			border-color 0.15s;
	}

	.panel-tab:hover {
		color: var(--color-text-primary);
		background: var(--color-bg-hover-alt);
	}

	.panel-tab.active {
		color: var(--color-primary);
		border-bottom-color: var(--color-primary);
		font-weight: 500;
	}

	.tab-badge {
		background: var(--color-tab-badge-bg);
		color: var(--color-tab-badge-text);
		font-size: 11px;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: 8px;
		min-width: 18px;
		text-align: center;
	}

	.config-btn {
		margin-left: auto;
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

	.config-btn:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	/* ── Thread Area ───────────────────────────────────────────────── */
	.thread-area {
		flex: 1;
		background: var(--color-bg-surface);
	}

	.threads-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 60px 24px;
		color: var(--color-text-secondary);
		font-size: 14px;
		gap: 12px;
	}

	.empty-panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 60px 24px;
		text-align: center;
	}

	.empty-panel p {
		color: var(--color-text-secondary);
		font-size: 14px;
		margin: 0 0 4px;
	}

	.empty-hint {
		font-size: 13px;
		color: var(--color-text-tertiary);
	}

	/* ── Thread List ───────────────────────────────────────────────── */
	.thread-list {
		border-top: none;
	}

	.thread-row {
		display: flex;
		align-items: center;
		border-bottom: 1px solid var(--color-border-subtle);
		padding: 0 8px 0 0;
		transition: background 0.1s;
		font-size: 14px;
		color: var(--color-text-secondary);
	}

	.thread-row:hover {
		background: var(--color-bg-hover-alt);
		box-shadow: inset 0 -1px 0 var(--color-border);
	}

	.thread-row.unread {
		background: var(--color-bg-unread);
	}

	.thread-row.unread .thread-from,
	.thread-row.unread .thread-subject {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.thread-checkbox {
		display: flex;
		align-items: center;
		padding: 12px;
		cursor: pointer;
		flex-shrink: 0;
	}

	.thread-checkbox input[type='checkbox'] {
		width: 18px;
		height: 18px;
		cursor: pointer;
		accent-color: var(--color-primary);
	}

	.thread-link {
		display: flex;
		align-items: center;
		flex: 1;
		min-width: 0;
		text-decoration: none;
		color: inherit;
		padding: 12px 8px;
		gap: 8px;
	}

	.thread-link:hover {
		text-decoration: none;
	}

	.thread-from {
		flex-shrink: 0;
		width: 200px;
		font-size: 14px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.thread-content {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.thread-subject {
		color: var(--color-text-primary);
	}

	.thread-snippet {
		color: var(--color-text-secondary);
	}

	.thread-count {
		flex-shrink: 0;
		font-size: 12px;
		color: var(--color-badge-text);
		background: var(--color-badge-bg);
		padding: 0 5px;
		border-radius: 3px;
		margin: 0 4px;
	}

	.thread-date {
		flex-shrink: 0;
		font-size: 12px;
		color: var(--color-text-secondary);
		text-align: right;
		min-width: 65px;
	}

	.thread-row.unread .thread-date {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	/* ── Load More ─────────────────────────────────────────────────── */
	.load-more {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 16px;
		text-align: center;
	}

	.load-more-btn {
		padding: 8px 24px;
		font-size: 14px;
		color: var(--color-primary);
		background: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
	}

	.load-more-btn:hover:not(:disabled) {
		background: var(--color-bg-hover-alt);
		border-color: var(--color-primary);
	}

	.load-more-btn:disabled {
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}

	.load-more-text {
		font-size: 13px;
		color: var(--color-text-secondary);
	}

	/* ── All Loaded Indicator ──────────────────────────────────────── */
	.all-loaded {
		padding: 16px;
		text-align: center;
	}

	.all-loaded-text {
		font-size: 13px;
		color: var(--color-text-tertiary);
	}

	/* ── Offline Badge (Header) ───────────────────────────────────── */
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

	/* ── Modal ─────────────────────────────────────────────────────── */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: var(--color-bg-overlay);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.modal {
		background: var(--color-bg-surface);
		border-radius: 8px;
		box-shadow: var(--color-modal-shadow);
		width: 720px;
		max-width: calc(100vw - 32px);
		max-height: calc(100vh - 64px);
		display: flex;
		flex-direction: column;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 20px 24px 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.modal-close {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-secondary);
		padding: 4px;
		border-radius: 50%;
		display: flex;
	}

	.modal-close:hover {
		background: var(--color-bg-hover);
	}

	/* ── Config Tabs (within modal) ────────────────────────────────── */
	.config-tabs {
		display: flex;
		border-bottom: 1px solid var(--color-border);
		padding: 0 16px;
	}

	.config-tab {
		padding: 10px 16px;
		font-size: 13px;
		color: var(--color-text-secondary);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		font-family: inherit;
	}

	.config-tab-wrapper {
		display: flex;
		align-items: center;
		position: relative;
	}

	.config-tab:hover {
		color: var(--color-text-primary);
	}

	.config-tab.active {
		color: var(--color-primary);
		border-bottom-color: var(--color-primary);
		font-weight: 500;
	}

	.tab-remove {
		position: absolute;
		right: 2px;
		top: 4px;
		width: 16px;
		height: 16px;
		padding: 0;
		font-size: 12px;
		line-height: 1;
		color: var(--color-text-tertiary);
		background: none;
		border: none;
		border-radius: 50%;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.tab-remove:hover {
		background: var(--color-error-surface);
		color: var(--color-error);
	}

	.add-tab {
		color: var(--color-primary);
		font-size: 18px;
		font-weight: 400;
		padding: 8px 14px;
	}

	.add-tab:hover {
		background: var(--color-bg-hover-alt);
		color: var(--color-primary-hover);
	}

	/* ── Config Body ───────────────────────────────────────────────── */
	.config-body {
		padding: 20px 24px;
		overflow-y: auto;
		flex: 1;
	}

	.config-field {
		margin-bottom: 20px;
	}

	.config-label {
		display: block;
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
		margin-bottom: 6px;
	}

	.config-input {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		font-size: 14px;
		font-family: inherit;
		box-sizing: border-box;
		background: var(--color-input-bg);
		color: var(--color-text-primary);
	}

	.config-input:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 1px var(--color-primary);
	}

	/* ── Rules Section ─────────────────────────────────────────────── */
	.config-rules {
		margin-top: 8px;
	}

	.rules-heading {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
		margin: 0 0 8px;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.rules-hint {
		font-weight: 400;
		color: var(--color-text-tertiary);
		font-size: 12px;
	}

	.no-rules {
		color: var(--color-text-tertiary);
		font-size: 13px;
		margin: 0 0 12px;
		font-style: italic;
	}

	/* ── Rule Cards ────────────────────────────────────────────────── */
	.rule-card {
		background: var(--color-bg-surface-dim);
		border-radius: 8px;
		padding: 12px;
		margin-bottom: 12px;
	}

	.rule-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}

	.rule-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.rule-field {
		margin-bottom: 8px;
	}

	.rule-field:last-child {
		margin-bottom: 0;
	}

	.rule-field-label {
		display: block;
		font-size: 12px;
		color: var(--color-text-secondary);
		margin-bottom: 4px;
	}

	.rule-select {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		font-size: 13px;
		font-family: inherit;
		background: var(--color-input-bg);
		color: var(--color-text-primary);
		box-sizing: border-box;
	}

	.rule-select:focus {
		outline: none;
		border-color: var(--color-primary);
	}

	.rule-pattern {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		font-size: 13px;
		font-family: 'Roboto Mono', monospace;
		box-sizing: border-box;
		background: var(--color-input-bg);
		color: var(--color-text-primary);
	}

	.rule-pattern:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 1px var(--color-primary);
	}

	.rule-remove {
		flex-shrink: 0;
		padding: 4px;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-secondary);
		border-radius: 50%;
		display: flex;
	}

	.rule-remove:hover {
		background: var(--color-error-surface);
		color: var(--color-error);
	}

	.add-rule-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		font-size: 13px;
		font-weight: 500;
		color: var(--color-primary);
		background: var(--color-bg-surface);
		border: 1px dashed var(--color-border);
		border-radius: 6px;
		cursor: pointer;
		font-family: inherit;
		margin-top: 4px;
	}

	.add-rule-btn:hover {
		background: var(--color-bg-hover-alt);
		border-color: var(--color-primary);
	}

	/* ── Catch-all hint ────────────────────────────────────────────── */
	.catchall-hint {
		font-size: 12px;
		color: var(--color-text-tertiary);
		margin: 16px 0 0;
		font-style: italic;
	}

	/* ── Modal Footer ──────────────────────────────────────────────── */
	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding: 16px 24px;
		border-top: 1px solid var(--color-border);
	}

	.btn-secondary {
		padding: 8px 20px;
		font-size: 14px;
		color: var(--color-text-secondary);
		background: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
	}

	.btn-secondary:hover {
		background: var(--color-bg-hover);
	}

	.btn-primary {
		padding: 8px 20px;
		font-size: 14px;
		color: var(--color-tab-badge-text);
		background: var(--color-primary);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
		font-weight: 500;
	}

	.btn-primary:hover {
		background: var(--color-primary-hover);
	}

	/* ── Pattern Help ──────────────────────────────────────────────── */
	.pattern-help {
		margin-top: 20px;
		border-top: 1px solid var(--color-border-light);
		padding-top: 16px;
	}

	.pattern-help-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 0;
		font-size: 13px;
		color: var(--color-primary);
		background: none;
		border: none;
		cursor: pointer;
		font-family: inherit;
	}

	.pattern-help-toggle:hover {
		text-decoration: underline;
	}

	.chevron {
		transition: transform 0.2s;
	}

	.chevron.expanded {
		transform: rotate(180deg);
	}

	.pattern-help-body {
		margin-top: 12px;
	}

	.pattern-help-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
		margin: 0 0 8px;
	}

	.pattern-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
		margin-bottom: 12px;
	}

	.pattern-table th {
		text-align: left;
		padding: 6px 12px;
		background: var(--color-bg-surface-dim);
		color: var(--color-text-secondary);
		font-weight: 500;
		font-size: 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.pattern-table td {
		padding: 6px 12px;
		border-bottom: 1px solid var(--color-border-subtle);
		color: var(--color-text-primary);
	}

	.pattern-table code {
		font-family: 'Roboto Mono', monospace;
		font-size: 12px;
		background: var(--color-code-bg);
		padding: 2px 6px;
		border-radius: 3px;
		color: var(--color-text-primary);
	}

	.pattern-note {
		font-size: 12px;
		color: var(--color-text-secondary);
		margin: 0;
		line-height: 1.5;
	}

	.pattern-note code {
		font-family: 'Roboto Mono', monospace;
		font-size: 11px;
		background: var(--color-code-bg);
		padding: 1px 4px;
		border-radius: 2px;
	}

	/* ── Onboarding Wizard ─────────────────────────────────────────── */
	.onboarding-modal {
		width: 720px;
	}

	.onboarding-welcome {
		padding: 48px 40px;
		text-align: center;
	}

	.onboarding-welcome h2 {
		margin: 0 0 12px;
		font-size: 22px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.onboarding-desc {
		font-size: 15px;
		color: var(--color-text-secondary);
		margin: 0 0 32px;
		line-height: 1.6;
		max-width: 480px;
		margin-left: auto;
		margin-right: auto;
	}

	.onboarding-actions {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	.btn-link {
		padding: 4px 8px;
		font-size: 13px;
		color: var(--color-text-secondary);
		background: none;
		border: none;
		cursor: pointer;
		font-family: inherit;
		text-decoration: underline;
	}

	.btn-link:hover {
		color: var(--color-text-primary);
	}

	.footer-right {
		display: flex;
		align-items: center;
		gap: 12px;
	}
</style>
