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
	import { browser } from '$app/environment';
	import { theme, toggleTheme } from '$lib/stores/theme';
	import type {
		ThreadMetadata,
		PanelConfig,
		ThreadsListApiResponse,
		ThreadsMetadataApiResponse
	} from '$lib/types.js';
	import { threadMatchesPanel, getDefaultPanels } from '$lib/rules.js';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { createOnlineState } from '$lib/offline.svelte.js';
	import { getCacheStats, clearAllCaches } from '$lib/cache.js';
	import { cacheThreadMetadata, getAllCachedMetadata, removeCachedMetadata } from '$lib/cache.js';
	import { formatListDate, decodeHtmlEntities } from '$lib/format.js';
	import { mergeThreads } from '$lib/inbox.js';
	import { getCsrfToken } from '$lib/csrf.js';

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

	/** Whether the initial thread load is in progress (no cached data available). */
	let loadingThreads: boolean = $state(false);

	/**
	 * Whether a silent background refresh is in progress.
	 * The UI continues showing cached data while this runs.
	 */
	let backgroundRefreshing: boolean = $state(false);

	/**
	 * Whether auto-fill or manual "load more" pagination is loading.
	 * Set once at the start and cleared once at the end for a smooth
	 * continuous spinner (no stutter start/stop per iteration).
	 */
	let autoFillLoading: boolean = $state(false);

	/**
	 * Dismissible error message from background operations (shown as toast).
	 * Unlike `errorMessage` which replaces the entire page, this overlays
	 * as a non-blocking notification when cached data is still available.
	 */
	let fetchError: string | null = $state(null);

	/**
	 * Whether the user is offline with no cached data available.
	 * Rendered as a graceful informational state (not an error) — the user
	 * isn't doing anything wrong, they just have no connectivity and no cache.
	 */
	let isOfflineNoData: boolean = $state(false);

	/** Panel configurations (loaded from localStorage). */
	let panels: PanelConfig[] = $state(getDefaultPanels());

	/** Index of the currently active panel tab. */
	let activePanel: number = $state(0);

	/** Set of selected thread IDs for bulk actions. Uses SvelteSet for reactivity. */
	let selectedThreads = new SvelteSet<string>();

	/** Whether a manual refresh (toolbar button) is in progress. */
	let refreshing: boolean = $state(false);

	/** Whether the trash confirmation modal is showing. */
	let showTrashConfirm: boolean = $state(false);

	/** Whether a trash API call is in progress (disables confirm button). */
	let trashLoading: boolean = $state(false);

	/** Whether the multiselect dropdown (All/None/Read/Unread) is open. */
	let showSelectDropdown: boolean = $state(false);

	/** Whether the "More options" dropdown is open. */
	let showMoreDropdown: boolean = $state(false);

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

	// =========================================================================
	// Search State
	// =========================================================================

	/** The current active search query. Empty string = normal inbox view. */
	let searchQuery: string = $state('');

	/** The text in the search input field (uncommitted until Enter is pressed). */
	let searchInputValue: string = $state('');

	/** Whether a search is active (derived from non-empty searchQuery). */
	let isSearchActive: boolean = $derived(searchQuery.length > 0);

	/** Thread metadata for search results (separate from inbox to preserve inbox state). */
	let searchThreadMetaList: ThreadMetadata[] = $state([]);

	/** Pagination token for loading more search result pages. */
	let searchNextPageToken: string | undefined = $state(undefined);

	/** Whether all search result pages have been loaded. */
	let searchAllLoaded: boolean = $state(false);

	/** Whether a search fetch is in progress (initial or new query). */
	let searchLoading: boolean = $state(false);

	/** Whether search auto-fill is loading more pages to fill the active panel. */
	let searchAutoFillLoading: boolean = $state(false);

	/** Per-panel page tracking for search results (separate from inbox). */
	let searchPanelPages = new SvelteMap<number, number>();

	// =========================================================================
	// Diagnostics Overlay (Ctrl+Shift+D)
	// =========================================================================

	/** Whether the diagnostics overlay is visible (toggled via Ctrl+Shift+D). */
	let showDebugOverlay: boolean = $state(false);

	/** Active tab inside the diagnostics overlay: counts vs system. */
	let debugTab: 'counts' | 'system' = $state('counts');

	// ── System Diagnostics State ────────────────────────────────────
	/** Number of cached thread metadata entries in IndexedDB. */
	let diagMetaCount: number = $state(0);

	/** Number of cached thread detail entries in IndexedDB. */
	let diagDetailCount: number = $state(0);

	/** Current Service Worker registration state. */
	let diagSwStatus: string = $state('Unknown');

	/** Whether a SW update is waiting to activate. */
	let diagSwUpdateAvailable: boolean = $state(false);

	/** Whether an IndexedDB cache clear is in progress. */
	let diagClearing: boolean = $state(false);

	/** Whether a factory reset is in progress. */
	let diagResetting: boolean = $state(false);

	/** Status message from the last diagnostics action. */
	let diagActionMessage: string | null = $state(null);

	/**
	 * Keyboard shortcut handler for diagnostics overlay.
	 * Ctrl+Shift+D toggles a floating panel showing live diagnostics.
	 */
	function handleDebugKeydown(e: KeyboardEvent): void {
		if (e.ctrlKey && e.shiftKey && e.key === 'D') {
			e.preventDefault();
			showDebugOverlay = !showDebugOverlay;
			if (showDebugOverlay) void loadDiagnostics();
		}
	}

	/** Loads cache stats and SW status for the diagnostics overlay. */
	async function loadDiagnostics(): Promise<void> {
		try {
			const stats = await getCacheStats();
			diagMetaCount = stats.metadataCount;
			diagDetailCount = stats.detailCount;
		} catch {
			/* IndexedDB unavailable — leave zeros. */
		}

		if (!('serviceWorker' in navigator)) {
			diagSwStatus = 'Not supported';
			return;
		}
		try {
			const reg = await navigator.serviceWorker.getRegistration();
			if (!reg) {
				diagSwStatus = 'Not registered';
			} else if (reg.waiting) {
				diagSwStatus = 'Update waiting';
				diagSwUpdateAvailable = true;
			} else if (reg.installing) {
				diagSwStatus = 'Installing';
			} else if (reg.active) {
				diagSwStatus = 'Active';
			} else {
				diagSwStatus = 'Registered (no active worker)';
			}
		} catch {
			diagSwStatus = 'Error checking status';
		}
	}

	/**
	 * Clears IndexedDB caches (thread metadata + detail).
	 * Refreshes cache stats after clearing.
	 */
	async function handleDiagClearCaches(): Promise<void> {
		diagClearing = true;
		diagActionMessage = null;
		try {
			await clearAllCaches();
			const stats = await getCacheStats();
			diagMetaCount = stats.metadataCount;
			diagDetailCount = stats.detailCount;
			diagActionMessage = 'Caches cleared.';
		} catch (err) {
			diagActionMessage = `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
		} finally {
			diagClearing = false;
		}
	}

	/**
	 * Full factory reset: clears IndexedDB, localStorage, SW caches,
	 * unregisters service workers, and reloads. Auth cookies are preserved.
	 */
	async function handleDiagFactoryReset(): Promise<void> {
		diagResetting = true;
		diagActionMessage = null;
		try {
			await clearAllCaches();
			localStorage.clear();
			if ('serviceWorker' in navigator) {
				const regs = await navigator.serviceWorker.getRegistrations();
				await Promise.all(regs.map((r) => r.unregister()));
			}
			if ('caches' in window) {
				const names = await caches.keys();
				await Promise.all(names.map((n) => caches.delete(n)));
			}
			diagActionMessage = 'Factory reset complete. Reloading...';
			setTimeout(() => location.reload(), 500);
		} catch (err) {
			diagActionMessage = `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
			diagResetting = false;
		}
	}

	/**
	 * Forces the waiting Service Worker to activate immediately
	 * and reloads the page to pick up the new version.
	 */
	async function handleDiagForceSwUpdate(): Promise<void> {
		diagActionMessage = null;
		try {
			const reg = await navigator.serviceWorker.getRegistration();
			if (reg?.waiting) {
				reg.waiting.postMessage({ type: 'SKIP_WAITING' });
				diagActionMessage = 'SW updated. Reloading...';
				setTimeout(() => location.reload(), 500);
			} else {
				diagActionMessage = 'No waiting SW found.';
			}
		} catch (err) {
			diagActionMessage = `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
		}
	}

	// =========================================================================
	// Per-Panel Count Estimates
	// =========================================================================

	/**
	 * Per-panel count data. `isEstimate` controls whether the tilde (~) is shown.
	 * - `isEstimate: false` → exact count from labels.get (no-rules panels without search)
	 * - `isEstimate: true` → approximate count from resultSizeEstimate
	 */

	/** Estimated counts for normal inbox view. null = not yet fetched. */
	let inboxCountEstimates: Array<{ total: number; unread: number; isEstimate: boolean }> | null =
		$state(null);

	/** Estimated counts for current search query. null = not yet fetched. */
	let searchCountEstimates: Array<{ total: number; unread: number; isEstimate: boolean }> | null =
		$state(null);

	/** Active estimates — switches based on whether search is active. */
	let panelCountEstimates = $derived.by(
		(): Array<{ total: number; unread: number; isEstimate: boolean }> | null => {
			return isSearchActive ? searchCountEstimates : inboxCountEstimates;
		}
	);

	/** Whether inbox panel counts are being fetched. */
	let inboxCountsLoading: boolean = $state(false);

	/** Whether search panel counts are being fetched. */
	let searchCountsLoading: boolean = $state(false);

	// =========================================================================
	// Constants
	// =========================================================================

	/** localStorage key for persisting panel configurations. */
	const PANELS_STORAGE_KEY = 'switchboard_panels';

	/** localStorage key for persisting per-panel page numbers. */
	const PANEL_PAGES_KEY = 'switchboard_panel_pages';

	/** localStorage key for persisting page size preference. */
	const PAGE_SIZE_KEY = 'switchboard_page_size';

	/** Valid page size options for the settings dropdown. */
	const PAGE_SIZE_OPTIONS = [10, 15, 20, 25, 50, 100] as const;

	/* MAX_AUTO_FILL_RETRIES removed — auto-fill now loops until page fills or tokens exhaust. */

	// =========================================================================
	// Configurable Page Size
	// =========================================================================

	/**
	 * Loads page size from localStorage with validation.
	 * Returns 20 (default) if no valid value is stored.
	 */
	function loadPageSize(): number {
		try {
			const saved = localStorage.getItem(PAGE_SIZE_KEY);
			if (saved) {
				const val = Number(saved);
				if (PAGE_SIZE_OPTIONS.includes(val as (typeof PAGE_SIZE_OPTIONS)[number])) return val;
			}
		} catch {
			/* localStorage unavailable — use default. */
		}
		return 20;
	}

	/** Persists page size to localStorage. */
	function savePageSize(size: number): void {
		try {
			localStorage.setItem(PAGE_SIZE_KEY, String(size));
		} catch {
			/* localStorage full or unavailable — silently ignore. */
		}
	}

	/** User-configurable threads per page. Loaded from localStorage, default 20. */
	let pageSize: number = $state(20);

	/* minPanelThreads removed — auto-fill targets currentPage * pageSize instead. */

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
	 * The thread list to display — search results when searching, inbox otherwise.
	 * Using a single derived value simplifies downstream consumers: they don't
	 * need to check `isSearchActive` before reading the list.
	 */
	let activeThreadList = $derived(isSearchActive ? searchThreadMetaList : threadMetaList);

	/**
	 * Per-panel statistics: total thread count and unread count.
	 *
	 * Uses `threadMatchesPanel` to check each thread against EVERY panel
	 * (not just assigned to one), allowing threads to appear in multiple panels.
	 *
	 * Unread badge strategy to prevent flicker:
	 *   - Before server estimates arrive: suppress badges (show 0 unread).
	 *   - After estimates arrive: use server unread counts exclusively.
	 *   - When all threads loaded: use exact loaded counts (small inbox/search).
	 */
	let panelStats = $derived.by(() => {
		/* Count from loaded threads as baseline for totals. */
		const loadedStats = panels.map(() => ({ total: 0, unread: 0 }));
		for (const thread of activeThreadList) {
			const fromRaw = reconstructFrom(thread);
			for (let i = 0; i < panels.length; i++) {
				if (threadMatchesPanel(panels[i], fromRaw, thread.to)) {
					loadedStats[i].total++;
					if (thread.labelIds.includes('UNREAD')) loadedStats[i].unread++;
				}
			}
		}

		/*
		 * If auto-fill loaded everything (small inbox or narrow search),
		 * loaded counts are exact — use them directly for both total and unread.
		 */
		const allLoaded = isSearchActive ? searchAllLoaded : allThreadsLoaded;
		if (allLoaded) return loadedStats;

		/*
		 * If server estimates haven't arrived yet, suppress unread badges.
		 * Showing partial-data unread counts would cause badges to flash
		 * then change once estimates arrive — confusing UX.
		 */
		if (!panelCountEstimates) {
			return loadedStats.map((s) => ({ total: s.total, unread: 0 }));
		}

		/*
		 * Merge server estimates with loaded data:
		 * - Total: max(estimate, loaded) — estimate is usually higher for large inboxes
		 * - Unread: use server estimate (accurate for no-rules panels via labels.get,
		 *   approximate for rules panels via resultSizeEstimate)
		 *
		 * Server unread is the source of truth because we typically only load a
		 * fraction of the total (e.g., 100 of 40K). Counting UNREAD from loaded
		 * threads would drastically undercount.
		 */
		return loadedStats.map((loaded, i) => {
			const est = panelCountEstimates![i];
			if (!est) return { total: loaded.total, unread: 0 };
			return {
				total: Math.max(est.total, loaded.total),
				unread: est.unread
			};
		});
	});

	/** Threads belonging to the currently active panel, sorted by date (newest first). */
	let currentPanelThreads = $derived.by(() => {
		const panel = panels[activePanel];
		if (!panel) return [];
		const filtered = activeThreadList.filter((thread) => {
			const fromRaw = reconstructFrom(thread);
			return threadMatchesPanel(panel, fromRaw, thread.to);
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
	// Pagination Derived Values
	// =========================================================================

	/**
	 * Per-panel page tracking. Maps panel index to 1-based page number.
	 * Preserved across panel switches so the user doesn't lose their place.
	 */
	let panelPages = new SvelteMap<number, number>();

	/**
	 * Current 1-based page number for the active panel.
	 * Uses the search-specific page map when a search is active.
	 */
	let currentPage = $derived(
		(isSearchActive ? searchPanelPages : panelPages).get(activePanel) ?? 1
	);

	/**
	 * Total number of pages for the active panel.
	 * Uses server estimate to enable forward pagination beyond loaded threads.
	 * When all threads are loaded, uses exact loaded count.
	 */
	let totalPanelPages = $derived.by(() => {
		const loaded = currentPanelThreads.length;

		/* If auto-fill loaded everything, use exact loaded count. */
		const allLoaded = isSearchActive ? searchAllLoaded : allThreadsLoaded;
		if (allLoaded) return Math.max(1, Math.ceil(loaded / pageSize));

		/* Otherwise use estimate to enable forward pagination. */
		const estimate = panelCountEstimates?.[activePanel]?.total;
		const total = estimate && estimate > loaded ? estimate : loaded;
		return Math.max(1, Math.ceil(total / pageSize));
	});

	/**
	 * The slice of threads visible on the current page.
	 * All sorting/filtering happens in `currentPanelThreads`;
	 * this derived value just slices for the current page window.
	 */
	let displayedThreads = $derived(
		currentPanelThreads.slice((currentPage - 1) * pageSize, currentPage * pageSize)
	);

	/**
	 * Gmail-style pagination display string.
	 *
	 * Display strategy:
	 *   - All threads loaded → exact: "1–20 of 500"
	 *   - Server count with `isEstimate: false` → exact: "1–20 of 500"
	 *   - Server count with `isEstimate: true` → approximate: "1–20 of ~500"
	 *   - No server data → loaded count: "1–20 of 47"
	 */
	let paginationDisplay = $derived.by(() => {
		const loaded = currentPanelThreads.length;
		if (loaded === 0) return '0 of 0';
		const start = (currentPage - 1) * pageSize + 1;
		const end = Math.min(currentPage * pageSize, loaded);

		/*
		 * If auto-fill exhausted all pages (small inbox or narrow search),
		 * loaded count is exact — use it directly, no `~`.
		 */
		const allLoaded = isSearchActive ? searchAllLoaded : allThreadsLoaded;
		if (allLoaded) return `${start}\u2013${end} of ${loaded.toLocaleString()}`;

		/*
		 * Use server counts as the source of truth for "total" when available.
		 * Always prefer server count — even if loaded count is higher (which can
		 * happen briefly during auto-fill), the server count is the canonical total.
		 * This prevents the "count increases with load" bug where the loaded count
		 * was shown and kept climbing as auto-fill fetched more threads.
		 */
		const panelCount = panelCountEstimates?.[activePanel];
		if (panelCount) {
			/* isEstimate = true → "~1,234", isEstimate = false → "1,234" */
			const displayTotal = Math.max(panelCount.total, loaded);
			const formatted = displayTotal.toLocaleString();
			const total = panelCount.isEstimate ? `~${formatted}` : formatted;
			return `${start}\u2013${end} of ${total}`;
		}

		/* Fallback: use loaded count only when server estimates are unavailable. */
		return `${start}\u2013${end} of ${loaded.toLocaleString()}`;
	});

	/** Auto-fill loading for the active context (search or inbox). */
	let activeAutoFillLoading = $derived(isSearchActive ? searchAutoFillLoading : autoFillLoading);

	/* activeNextPageToken and activeAllLoaded removed — bottom UI removed, auto-fill runs silently. */

	/**
	 * Whether the master checkbox (in toolbar) is in a checked or
	 * indeterminate state. Checked = all on page selected, indeterminate
	 * = some selected, unchecked = none selected.
	 */
	let masterCheckState = $derived.by((): 'all' | 'some' | 'none' => {
		if (displayedThreads.length === 0) return 'none';
		const selectedOnPage = displayedThreads.filter((t) => selectedThreads.has(t.id)).length;
		if (selectedOnPage === 0) return 'none';
		if (selectedOnPage === displayedThreads.length) return 'all';
		return 'some';
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
	 * Core thread page fetcher — performs the two-phase fetch without mutating
	 * component state. Callers are responsible for updating UI state based on
	 * the returned data. This separation enables both blocking (initial load)
	 * and non-blocking (background refresh) usage with the same fetch logic.
	 *
	 * Two-phase pattern:
	 *   1. GET /api/threads → thread IDs + snippets
	 *   2. POST /api/threads/metadata → full headers for those IDs
	 *
	 * @param pageToken - Pagination token for loading subsequent pages.
	 * @param q - Optional Gmail search query string. When provided, the API
	 *   filters results to threads matching the query within the inbox.
	 * @returns Object with fetched threads and optional next page token.
	 * @throws Error on HTTP errors or network failures. Throws with message
	 *         'AUTH_REDIRECT' after initiating a redirect to /login on 401.
	 */
	async function fetchThreadPage(
		pageToken?: string,
		q?: string
	): Promise<{
		threads: ThreadMetadata[];
		nextPageToken?: string;
	}> {
		/* Phase 1: Get thread IDs. Build URL with optional params. */
		const params = new URLSearchParams();
		if (pageToken) params.set('pageToken', pageToken);
		if (q) params.set('q', q);

		const listUrl = params.toString() ? `/api/threads?${params.toString()}` : '/api/threads';

		const listRes = await fetch(listUrl);

		if (listRes.status === 401) {
			goto('/login');
			throw new Error('AUTH_REDIRECT');
		}

		if (!listRes.ok) {
			const body = await listRes.json().catch(() => ({}));
			throw new Error(body.message ?? `Failed to load threads (HTTP ${listRes.status})`);
		}

		const listData: ThreadsListApiResponse = await listRes.json();

		if (listData.threads.length === 0) {
			return { threads: [], nextPageToken: listData.nextPageToken };
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
			throw new Error('AUTH_REDIRECT');
		}

		if (!metaRes.ok) {
			const body = await metaRes.json().catch(() => ({}));
			throw new Error(body.message ?? `Failed to load thread details (HTTP ${metaRes.status})`);
		}

		const metaData: ThreadsMetadataApiResponse = await metaRes.json();
		return { threads: metaData.threads, nextPageToken: listData.nextPageToken };
	}

	/**
	 * Performs a silent background refresh of the first page of threads.
	 *
	 * This is the key function for the stale-while-revalidate pattern:
	 * the UI continues showing cached data while fresh data is fetched and
	 * surgically merged in. The user sees no loading spinner, no blank flash,
	 * just seamless updates (new threads appear, labels change, etc.).
	 *
	 * On failure, shows a dismissible error toast instead of replacing the page.
	 */
	async function backgroundRefresh(): Promise<void> {
		backgroundRefreshing = true;

		try {
			const result = await fetchThreadPage();

			/* Update pagination state from the fresh server response. */
			nextPageToken = result.nextPageToken;
			allThreadsLoaded = !result.nextPageToken;

			/* Surgically merge server threads into the local list. */
			threadMetaList = mergeThreads(threadMetaList, result.threads, 'refresh');

			/* Cache the fetched data for offline access. */
			try {
				await cacheThreadMetadata(result.threads);
			} catch {
				/* Cache write failed — non-critical, skip silently. */
			}
		} catch (err) {
			if (err instanceof Error && err.message === 'AUTH_REDIRECT') return;

			/*
			 * Background errors are shown as a dismissible toast, NOT as a
			 * page-level error, since the user still has cached data to view.
			 */
			if (threadMetaList.length > 0) {
				fetchError = err instanceof Error ? err.message : 'Failed to refresh inbox';
			} else if (!online.current) {
				/*
				 * Offline with no data — show a graceful informational state,
				 * NOT an error. The user isn't at fault; they just need connectivity.
				 */
				isOfflineNoData = true;
			} else {
				/* Online but failed — this is an actual error. */
				errorMessage = err instanceof Error ? err.message : 'Failed to load inbox';
			}
		} finally {
			backgroundRefreshing = false;
		}
	}

	/**
	 * Performs a blocking initial fetch with a loading spinner.
	 *
	 * Used when there's no cached data available (first-ever load, post-onboarding).
	 * Unlike `backgroundRefresh()`, this sets `loadingThreads` to show the
	 * full-page spinner and replaces `threadMetaList` entirely (since there's
	 * nothing to merge with).
	 */
	async function initialBlockingFetch(): Promise<void> {
		loadingThreads = true;

		try {
			const result = await fetchThreadPage();
			nextPageToken = result.nextPageToken;
			allThreadsLoaded = !result.nextPageToken;
			threadMetaList = result.threads;

			try {
				await cacheThreadMetadata(result.threads);
			} catch {
				/* Cache write failed — non-critical. */
			}
		} catch (err) {
			if (!(err instanceof Error && err.message === 'AUTH_REDIRECT')) {
				if (!online.current) {
					isOfflineNoData = true;
				} else {
					errorMessage = err instanceof Error ? err.message : 'Failed to load inbox';
				}
			}
		} finally {
			loadingThreads = false;
		}
	}

	/* handleLoadMore() removed — auto-fill runs silently without a manual button. */

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
	// Pagination Helpers
	// =========================================================================

	/**
	 * Gets the 1-based page number for the given panel index.
	 * Defaults to 1 if no page has been set for that panel.
	 */
	function getPanelPage(idx: number): number {
		return panelPages.get(idx) ?? 1;
	}

	/**
	 * Sets the page number for the given panel index.
	 * Writes to the search-specific map when a search is active,
	 * so inbox and search pagination are tracked independently.
	 */
	function setPanelPage(idx: number, page: number): void {
		if (isSearchActive) {
			searchPanelPages.set(idx, page);
		} else {
			panelPages.set(idx, page);
		}
	}

	/**
	 * Advances to the next page in the active panel.
	 * Triggers auto-fill if more threads might be needed.
	 */
	function nextPage(): void {
		if (currentPage < totalPanelPages) {
			setPanelPage(activePanel, currentPage + 1);
			void maybeAutoFill();
		}
	}

	/** Goes to the previous page in the active panel. */
	function prevPage(): void {
		if (currentPage > 1) {
			setPanelPage(activePanel, currentPage - 1);
		}
	}

	/**
	 * Toggles the master (header) checkbox.
	 * If all displayed threads are selected, deselects all on page.
	 * Otherwise, selects all displayed threads on the current page.
	 */
	function toggleMasterCheckbox(): void {
		if (masterCheckState === 'all') {
			/* Deselect all on current page. */
			for (const t of displayedThreads) {
				selectedThreads.delete(t.id);
			}
		} else {
			/* Select all on current page. */
			for (const t of displayedThreads) {
				selectedThreads.add(t.id);
			}
		}
	}

	// =========================================================================
	// Multiselect Dropdown Helpers
	// =========================================================================

	/** Selects all threads on the current page. */
	function selectAll(): void {
		for (const t of displayedThreads) selectedThreads.add(t.id);
		showSelectDropdown = false;
	}

	/** Deselects all threads (entire panel, not just page). */
	function selectNone(): void {
		selectedThreads.clear();
		showSelectDropdown = false;
	}

	/** Selects only read threads on the current page. */
	function selectRead(): void {
		selectedThreads.clear();
		for (const t of displayedThreads) {
			if (!t.labelIds.includes('UNREAD')) selectedThreads.add(t.id);
		}
		showSelectDropdown = false;
	}

	/** Selects only unread threads on the current page. */
	function selectUnread(): void {
		selectedThreads.clear();
		for (const t of displayedThreads) {
			if (t.labelIds.includes('UNREAD')) selectedThreads.add(t.id);
		}
		showSelectDropdown = false;
	}

	// =========================================================================
	// Mark as Read
	// =========================================================================

	/**
	 * Marks a single thread as read (optimistic UI update).
	 *
	 * Immediately removes the UNREAD label from the local thread list
	 * and fires-and-forgets an API call to update the server. If the API
	 * call fails, the label mismatch is self-correcting on next refresh.
	 *
	 * @param threadId - The Gmail thread ID to mark as read.
	 */
	function markAsRead(threadId: string): void {
		/* Find the thread and check if already read. */
		const thread = threadMetaList.find((t) => t.id === threadId);
		if (!thread || !thread.labelIds.includes('UNREAD')) return;

		/* Optimistically decrement unread counts in panel estimates. */
		decrementUnreadCounts([threadId]);

		/* Optimistic update: remove UNREAD label locally. */
		thread.labelIds = thread.labelIds.filter((l) => l !== 'UNREAD');
		/* Trigger reactivity by reassigning the array. */
		threadMetaList = [...threadMetaList];

		/* Also update in search results if present (cross-list sync). */
		const searchThread = searchThreadMetaList.find((t) => t.id === threadId);
		if (searchThread && searchThread.labelIds.includes('UNREAD')) {
			searchThread.labelIds = searchThread.labelIds.filter((l) => l !== 'UNREAD');
			searchThreadMetaList = [...searchThreadMetaList];
		}

		/* Fire-and-forget API call. Failure is self-correcting on next refresh. */
		fetch('/api/threads/read', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ threadIds: [threadId] })
		}).catch(() => {
			/* Silently ignore — will re-sync on next background refresh. */
		});
	}

	/**
	 * Batch marks the selected threads as read (toolbar action).
	 *
	 * Collects all selected thread IDs that have the UNREAD label,
	 * optimistically removes the label locally, and fires-and-forgets
	 * the API call. Clears the selection when done.
	 */
	function handleMarkRead(): void {
		const unreadIds = [...selectedThreads].filter((id) => {
			const t = activeThreadList.find((thread) => thread.id === id);
			return t?.labelIds.includes('UNREAD');
		});

		if (unreadIds.length === 0) return;

		/* Optimistically decrement unread counts in panel estimates. */
		decrementUnreadCounts(unreadIds);

		/* Optimistic update: remove UNREAD from all selected threads in both lists. */
		for (const id of unreadIds) {
			const t = threadMetaList.find((thread) => thread.id === id);
			if (t) t.labelIds = t.labelIds.filter((l) => l !== 'UNREAD');
			const st = searchThreadMetaList.find((thread) => thread.id === id);
			if (st) st.labelIds = st.labelIds.filter((l) => l !== 'UNREAD');
		}
		threadMetaList = [...threadMetaList];
		if (searchThreadMetaList.length > 0) searchThreadMetaList = [...searchThreadMetaList];
		selectedThreads.clear();

		/* Fire-and-forget API call for all unread IDs at once. */
		fetch('/api/threads/read', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ threadIds: unreadIds })
		}).catch(() => {
			/* Silently ignore — will re-sync on next refresh. */
		});
	}

	/**
	 * Marks ALL unread threads in the current panel as read.
	 * Triggered from the "More options" dropdown.
	 */
	function handleMarkAllRead(): void {
		showMoreDropdown = false;

		const unreadInPanel = currentPanelThreads.filter((t) => t.labelIds.includes('UNREAD'));
		if (unreadInPanel.length === 0) return;

		const ids = unreadInPanel.map((t) => t.id);

		/* Optimistically decrement unread counts in panel estimates. */
		decrementUnreadCounts(ids);

		/* Optimistic update: update both inbox and search lists. */
		for (const id of ids) {
			const t = threadMetaList.find((thread) => thread.id === id);
			if (t) t.labelIds = t.labelIds.filter((l) => l !== 'UNREAD');
			const st = searchThreadMetaList.find((thread) => thread.id === id);
			if (st) st.labelIds = st.labelIds.filter((l) => l !== 'UNREAD');
		}
		threadMetaList = [...threadMetaList];
		if (searchThreadMetaList.length > 0) searchThreadMetaList = [...searchThreadMetaList];

		/* Fire-and-forget (batched via the server endpoint). */
		fetch('/api/threads/read', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ threadIds: ids })
		}).catch(() => {
			/* Silently ignore — will re-sync on next refresh. */
		});
	}

	// =========================================================================
	// Optimistic Unread Count Decrement
	// =========================================================================

	/**
	 * Optimistically decrements the unread count in panel count estimates
	 * when threads are marked as read.
	 *
	 * Counts how many of the given thread IDs are currently unread per panel,
	 * then subtracts those counts from `inboxCountEstimates` and/or
	 * `searchCountEstimates`. This keeps unread badges in sync without
	 * waiting for a server round-trip.
	 *
	 * @param threadIds - IDs of threads being marked as read.
	 */
	function decrementUnreadCounts(threadIds: string[]): void {
		/* Count how many unread threads per panel are being marked read. */
		const perPanel = panels.map(() => 0);
		for (const id of threadIds) {
			const thread = activeThreadList.find((t) => t.id === id);
			if (!thread || !thread.labelIds.includes('UNREAD')) continue;
			const fromRaw = reconstructFrom(thread);
			for (let i = 0; i < panels.length; i++) {
				if (threadMatchesPanel(panels[i], fromRaw, thread.to)) {
					perPanel[i]++;
				}
			}
		}

		/* Decrement in inbox estimates. */
		if (inboxCountEstimates) {
			inboxCountEstimates = inboxCountEstimates.map((c, i) => ({
				...c,
				unread: Math.max(0, c.unread - perPanel[i])
			}));
		}

		/* Decrement in search estimates (if active). */
		if (searchCountEstimates) {
			searchCountEstimates = searchCountEstimates.map((c, i) => ({
				...c,
				unread: Math.max(0, c.unread - perPanel[i])
			}));
		}
	}

	// =========================================================================
	// Trash (Batch Delete)
	// =========================================================================

	/**
	 * Handles the trash confirmation action.
	 *
	 * Flow: snapshot → optimistic remove → clear selection → remove from
	 * IndexedDB → POST with CSRF → on partial failure: rollback failed IDs
	 * → on full failure: rollback all.
	 */
	async function handleTrash(): Promise<void> {
		const idsToTrash = [...selectedThreads];
		if (idsToTrash.length === 0) return;

		trashLoading = true;

		/* Snapshot for rollback on failure. */
		const snapshot = [...threadMetaList];
		const searchSnapshot = [...searchThreadMetaList];

		/* Optimistic UI: remove trashed threads from both lists. */
		threadMetaList = threadMetaList.filter((t) => !idsToTrash.includes(t.id));
		searchThreadMetaList = searchThreadMetaList.filter((t) => !idsToTrash.includes(t.id));
		selectedThreads.clear();
		showTrashConfirm = false;

		/*
		 * Ensure current page is still valid after removing threads.
		 * If the user was on the last page and all its threads were trashed,
		 * we need to step back to avoid showing an empty page.
		 */
		if (currentPage > totalPanelPages && totalPanelPages > 0) {
			setPanelPage(activePanel, totalPanelPages);
		}

		/* Remove from IndexedDB cache (fire-and-forget, non-critical). */
		for (const id of idsToTrash) {
			removeCachedMetadata(id).catch(() => {});
		}

		/* POST to server with CSRF token. */
		const csrfToken = getCsrfToken();
		try {
			const res = await fetch('/api/threads/trash', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(csrfToken ? { 'x-csrf-token': csrfToken } : {})
				},
				body: JSON.stringify({ threadIds: idsToTrash })
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message ?? `HTTP ${res.status}`);
			}

			const data: { results: Array<{ threadId: string; success: boolean; error?: string }> } =
				await res.json();

			/*
			 * Check for partial failures: if some threads failed to trash,
			 * rollback only the failed ones back into the list.
			 */
			const failedIds = data.results.filter((r) => !r.success).map((r) => r.threadId);

			if (failedIds.length > 0) {
				const failedThreads = snapshot.filter((t) => failedIds.includes(t.id));
				threadMetaList = mergeThreads(threadMetaList, failedThreads, 'refresh');
				fetchError = `Failed to trash ${failedIds.length} of ${idsToTrash.length} threads.`;
			}
		} catch (err) {
			/* Full failure: rollback all trashed threads in both lists. */
			threadMetaList = snapshot;
			searchThreadMetaList = searchSnapshot;
			fetchError = err instanceof Error ? err.message : 'Failed to trash threads';
		} finally {
			trashLoading = false;
		}
	}

	// =========================================================================
	// Toolbar: Refresh
	// =========================================================================

	/**
	 * Manual refresh triggered by the toolbar refresh button.
	 * Runs the same surgical background refresh, but shows a spinner
	 * on the refresh icon to give the user feedback.
	 */
	async function handleRefresh(): Promise<void> {
		if (refreshing || !online.current) return;
		refreshing = true;
		try {
			await backgroundRefresh();
		} finally {
			refreshing = false;
		}
	}

	// =========================================================================
	// Search Functions
	// =========================================================================

	/**
	 * Executes a search query against the Gmail API.
	 *
	 * Clears previous search state, fetches the first page of results,
	 * caches them, and triggers auto-fill if the active panel has fewer
	 * results than the page size.
	 *
	 * Search results are stored in a separate list (`searchThreadMetaList`)
	 * to preserve the inbox state — toggling between search and inbox is
	 * instant because neither list is destroyed.
	 *
	 * @param query - The Gmail search query string (trimmed by caller).
	 */
	async function executeSearch(query: string): Promise<void> {
		if (!query.trim()) return;

		searchQuery = query.trim();
		searchThreadMetaList = [];
		searchNextPageToken = undefined;
		searchAllLoaded = false;
		searchCountEstimates = null;
		searchPanelPages = new SvelteMap<number, number>();
		selectedThreads.clear();
		searchLoading = true;

		try {
			const result = await fetchThreadPage(undefined, searchQuery);
			searchNextPageToken = result.nextPageToken;
			searchAllLoaded = !result.nextPageToken;
			searchThreadMetaList = result.threads;

			try {
				await cacheThreadMetadata(result.threads);
			} catch {
				/* Cache write failure is non-critical. */
			}
		} catch (err) {
			if (err instanceof Error && err.message === 'AUTH_REDIRECT') return;
			fetchError = err instanceof Error ? err.message : 'Search failed';
		} finally {
			searchLoading = false;
		}

		/* Fetch search-scoped per-panel counts (all panels show `~` during search). */
		void fetchPanelCounts(searchQuery);
		await maybeAutoFill();
	}

	/**
	 * Clears the active search and returns to the normal inbox view.
	 *
	 * Resets all search-related state without re-fetching inbox data —
	 * the inbox thread list is preserved throughout the search session.
	 */
	function clearSearch(): void {
		searchQuery = '';
		searchInputValue = '';
		searchThreadMetaList = [];
		searchNextPageToken = undefined;
		searchAllLoaded = false;
		searchCountEstimates = null;
		searchPanelPages = new SvelteMap<number, number>();
		selectedThreads.clear();
	}

	/**
	 * Handles search form submission (Enter key or form submit).
	 * Trims the input and delegates to `executeSearch` if non-empty.
	 */
	function handleSearchSubmit(): void {
		const query = searchInputValue.trim();
		if (query) void executeSearch(query);
	}

	// =========================================================================
	// Panel Count Estimates
	// =========================================================================

	/**
	 * Fetches per-panel counts from the server.
	 *
	 * Sends panel configurations and an optional search query. The server
	 * returns counts with an `isEstimate` flag per panel:
	 *   - No-rules panels without search → exact (via labels.get)
	 *   - All other cases → estimated (via resultSizeEstimate)
	 *
	 * Results are stored in `inboxCountEstimates` or `searchCountEstimates`
	 * depending on whether a search query was provided. This is non-critical —
	 * failures are silently ignored and the UI falls back to loaded-thread counts.
	 *
	 * @param forSearchQuery - Optional search query. When provided, results
	 *   are stored in `searchCountEstimates` instead of `inboxCountEstimates`.
	 */
	async function fetchPanelCounts(forSearchQuery?: string): Promise<void> {
		/*
		 * Separate loading guards for inbox vs search — prevents the search
		 * count fetch from being blocked by an in-flight inbox count fetch
		 * (and vice versa). This ensures both can run concurrently.
		 */
		const isSearch = !!forSearchQuery;
		if (isSearch ? searchCountsLoading : inboxCountsLoading) return;
		if (!online.current) return;
		if (isSearch) searchCountsLoading = true;
		else inboxCountsLoading = true;

		try {
			const bodyPayload: { panels: PanelConfig[]; searchQuery?: string } = { panels };
			if (forSearchQuery) bodyPayload.searchQuery = forSearchQuery;
			const csrfToken = getCsrfToken();
			const res = await fetch('/api/threads/counts', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(csrfToken ? { 'x-csrf-token': csrfToken } : {})
				},
				body: JSON.stringify(bodyPayload)
			});
			if (!res.ok) return; /* Silently fail — counts are non-critical. */
			const data = await res.json();
			if (forSearchQuery) {
				searchCountEstimates = data.counts;
			} else {
				inboxCountEstimates = data.counts;
			}
		} catch {
			/* Non-critical — use loaded counts as fallback. */
		} finally {
			if (isSearch) searchCountsLoading = false;
			else inboxCountsLoading = false;
		}
	}

	// =========================================================================
	// Dropdown Click-Outside Handling
	// =========================================================================

	/**
	 * Closes any open dropdowns when clicking outside them.
	 * Attached to the document via a Svelte action or event handler.
	 */
	function handleClickOutside(e: MouseEvent): void {
		const target = e.target as HTMLElement;

		/*
		 * Check if the click is inside any dropdown or its toggle button.
		 * If not, close all open dropdowns.
		 */
		if (showSelectDropdown && !target.closest('.select-dropdown-wrapper')) {
			showSelectDropdown = false;
		}
		if (showMoreDropdown && !target.closest('.more-dropdown-wrapper')) {
			showMoreDropdown = false;
		}
	}

	// =========================================================================
	// Auto-Fill Logic
	// =========================================================================

	/**
	 * Loads additional thread pages silently until the active panel has
	 * enough threads to fill all pages up to and including `currentPage`.
	 *
	 * Does NOT load all threads — only what's needed for display. For a
	 * 40K inbox, we load enough to fill the visible page (e.g., 20-100
	 * threads), not all 800 pages.
	 *
	 * Target: `currentPage * pageSize` threads in the active panel.
	 * Loops until that target is met or `nextPageToken` is exhausted.
	 *
	 * No bottom UI indicators — `autoFillLoading`/`searchAutoFillLoading`
	 * are kept only as concurrency guards and for the tab loading dot.
	 *
	 * Called after initial load, background refresh, panel switches, and
	 * pagination (next page).
	 */
	async function maybeAutoFill(): Promise<void> {
		const neededThreads = currentPage * pageSize;

		/* ── Search-active branch: auto-fill search results ────────── */
		if (isSearchActive) {
			if (searchAutoFillLoading || searchAllLoaded || !searchNextPageToken) return;
			searchAutoFillLoading = true;
			try {
				while (
					!searchAllLoaded &&
					searchNextPageToken &&
					currentPanelThreads.length < neededThreads
				) {
					const result = await fetchThreadPage(searchNextPageToken, searchQuery);
					searchNextPageToken = result.nextPageToken;
					if (!result.nextPageToken) searchAllLoaded = true;
					searchThreadMetaList = mergeThreads(searchThreadMetaList, result.threads, 'append');
					try {
						await cacheThreadMetadata(result.threads);
					} catch {
						/* Cache write failure is non-critical. */
					}
				}
			} catch (err) {
				if (err instanceof Error && err.message === 'AUTH_REDIRECT') return;
				fetchError = err instanceof Error ? err.message : 'Failed to load more results';
			} finally {
				searchAutoFillLoading = false;
			}
			return;
		}

		/* ── Normal inbox branch ───────────────────────────────────── */
		/* Guard: don't start if already running, exhausted, or no token. */
		if (autoFillLoading || allThreadsLoaded || !nextPageToken) return;

		autoFillLoading = true;

		try {
			while (!allThreadsLoaded && nextPageToken && currentPanelThreads.length < neededThreads) {
				const result = await fetchThreadPage(nextPageToken);
				nextPageToken = result.nextPageToken;
				if (!result.nextPageToken) {
					allThreadsLoaded = true;
				}

				threadMetaList = mergeThreads(threadMetaList, result.threads, 'append');

				/* Cache fetched data for offline access. */
				try {
					await cacheThreadMetadata(result.threads);
				} catch {
					/* Cache write failed — non-critical. */
				}
			}
		} catch (err) {
			if (err instanceof Error && err.message === 'AUTH_REDIRECT') return;
			fetchError = err instanceof Error ? err.message : 'Failed to load more threads';
		} finally {
			autoFillLoading = false;
		}
	}

	/**
	 * Switches to a different panel tab.
	 * Selection is cleared on panel switch to avoid stale selections.
	 * Auto-fill is NOT triggered here — it only runs on page refresh.
	 *
	 * @param index - The panel index to switch to.
	 */
	function switchPanel(index: number): void {
		activePanel = index;
		selectedThreads.clear();
		/* Close any open dropdowns. */
		showSelectDropdown = false;
		showMoreDropdown = false;
		/* Auto-fill only runs on initial page load (refresh), not on panel switch. */
	}

	// =========================================================================
	// Config Modal
	// =========================================================================

	/** Page size being edited in the settings modal (committed on Save). */
	let editingPageSize: number = $state(20);

	/** Opens the settings modal with a deep clone of current panels and page size. */
	function openConfig(): void {
		editingPanels = JSON.parse(JSON.stringify(panels));
		editingPanelIndex = 0;
		editingPageSize = pageSize;
		showConfig = true;
	}

	/**
	 * Saves the edited panel config + page size and closes the modal.
	 * If the page size changed, resets all panel page numbers since
	 * the old page boundaries no longer make sense.
	 */
	function saveConfig(): void {
		panels = JSON.parse(JSON.stringify(editingPanels));
		savePanels(panels);
		/* Ensure activePanel doesn't exceed new panel count. */
		if (activePanel >= panels.length) {
			activePanel = panels.length - 1;
		}
		/* Persist page size if changed. */
		if (editingPageSize !== pageSize) {
			pageSize = editingPageSize;
			savePageSize(pageSize);
			/* Reset all panel page numbers since page size changed. */
			panelPages = new SvelteMap<number, number>();
		}
		showConfig = false;
		/* Refresh panel counts since panel rules may have changed. */
		void fetchPanelCounts();
		if (isSearchActive) void fetchPanelCounts(searchQuery);
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

	/** Finishes onboarding: saves panels and does a blocking initial fetch. */
	async function finishOnboarding(): Promise<void> {
		panels = JSON.parse(JSON.stringify(editingPanels));
		savePanels(panels);
		showOnboarding = false;
		/* First-ever load — no cache, so use blocking fetch with spinner. */
		await initialBlockingFetch();
		await maybeAutoFill();
	}

	/** Skips onboarding: saves a single "Inbox" panel (no rules = shows all) and fetches. */
	async function skipOnboarding(): Promise<void> {
		panels = [{ name: 'Inbox', rules: [] }];
		savePanels(panels);
		showOnboarding = false;
		/* First-ever load — no cache, so use blocking fetch with spinner. */
		await initialBlockingFetch();
		await maybeAutoFill();
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	onMount(async () => {
		/* Register click-outside handler for closing dropdowns. */
		document.addEventListener('click', handleClickOutside);

		/* Register keyboard shortcut for debug overlay (Ctrl+Shift+D). */
		document.addEventListener('keydown', handleDebugKeydown);

		/* Load saved panel config and page size from localStorage. */
		panels = loadPanels();
		pageSize = loadPageSize();

		/* ── Step 1: Check authentication ────────────────────────────── */
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
					/* Cache read failed — fall through to offline state. */
				}

				/*
				 * Offline with no cache — show graceful informational state,
				 * not an error. The user just needs to go online.
				 */
				isOfflineNoData = true;
				loading = false;
				return;
			}

			/* Online but auth check failed — this is an actual error. */
			errorMessage = err instanceof Error ? err.message : 'Failed to check authentication';
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
		 * ── Step 2: Cache-first loading pattern ─────────────────────
		 *
		 * 1. Load cached thread list → display immediately (no flash).
		 * 2. If online and has cache: silent background refresh → merge.
		 *    If online and no cache: blocking fetch with spinner.
		 * 3. Auto-fill panels that need more threads (smooth spinner).
		 *
		 * The user sees their cached emails instantly. Server data is
		 * merged surgically in the background — no blank flash, no
		 * progressive refill.
		 */
		let hasCachedData = false;
		try {
			const cached = await getAllCachedMetadata();
			if (cached.length > 0) {
				threadMetaList = cached.map((c) => c.data);
				hasCachedData = true;
			}
		} catch {
			/* Cache read failed — will fetch from network below. */
		}

		if (online.current) {
			/*
			 * Fetch panel counts EARLY — runs in parallel with data loading.
			 * This prevents the "count increases with load" bug: without early
			 * counts, paginationDisplay uses loaded-thread count as fallback
			 * (which increases during auto-fill). With early counts, the server's
			 * exact/estimated total is displayed from the start.
			 *
			 * Also prevents unread badge suppression: panelStats suppresses badges
			 * while panelCountEstimates is null. Fetching counts early means
			 * badges appear as soon as data arrives, not after auto-fill finishes.
			 */
			void fetchPanelCounts();

			if (hasCachedData) {
				/* Cache available: silent background refresh merges changes. */
				await backgroundRefresh();
			} else {
				/* No cache: blocking fetch with loading spinner. */
				await initialBlockingFetch();
			}
			/* Auto-fill panels with smooth continuous loading. */
			await maybeAutoFill();

			/* Handle ?q= URL parameter — navigate to inbox with search query. */
			const urlQuery = new URLSearchParams(window.location.search).get('q');
			if (urlQuery) {
				searchInputValue = urlQuery;
				void executeSearch(urlQuery);
			}
		} else if (hasCachedData) {
			/* Offline with cache — show cached data, mark as complete. */
			allThreadsLoaded = true;
		} else {
			/*
			 * Offline with no cache and no auth — graceful offline state.
			 * This path is reached if the auth check succeeded but we have
			 * no cached data and lost connectivity before fetching.
			 */
			isOfflineNoData = true;
		}
	});

	/**
	 * Locks body scroll when any modal is open to prevent background scrolling.
	 * Restores scroll on modal close. Cleanup runs automatically on unmount.
	 */
	$effect(() => {
		const anyModalOpen = showConfig || showTrashConfirm || showOnboarding;
		document.body.style.overflow = anyModalOpen ? 'hidden' : '';
		return () => {
			document.body.style.overflow = '';
		};
	});

	onDestroy(() => {
		if (browser) {
			document.removeEventListener('click', handleClickOutside);
			document.removeEventListener('keydown', handleDebugKeydown);
		}
		online.destroy();
	});
</script>

<svelte:head>
	<title>{isSearchActive ? `Search: ${searchQuery} -` : ''} Inbox - Email Switchboard</title>
</svelte:head>

{#if loading}
	<!-- ── Full-page loading spinner (auth check) ──────────────────── -->
	<main class="loading-page">
		<div class="loading-content">
			<div class="spinner"></div>
			<p>Loading…</p>
		</div>
	</main>
{:else if isOfflineNoData}
	<!-- ── Offline with no data (graceful, not error) ─────────────── -->
	<main class="offline-page">
		<div class="offline-card">
			<svg class="offline-icon" viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
				<path
					d="M24 8.98C20.93 5.9 16.69 4 12 4c-1.21 0-2.4.13-3.55.37l2.07 2.07C11 6.15 11.5 6 12 6c3.87 0 7.39 1.57 9.95 4.11L24 8.98zM2.81 1.63L1.39 3.05l2.07 2.07C1.28 7.08 0 9.95 0 13.12L2.05 15.17C2.03 14.82 2 14.47 2 14.12c0-2.55.93-4.88 2.47-6.67l1.48 1.48C4.73 10.53 4 12.25 4 14.12l2.05 2.05c-.03-.35-.05-.7-.05-1.05 0-2.36.96-4.5 2.51-6.05l1.47 1.47C8.76 11.76 8 12.87 8 14.12l2 2c0-1.1.9-2 2-2 .36 0 .7.1 1 .28l7.95 7.95 1.41-1.41L2.81 1.63z"
				/>
			</svg>
			<h2>You're offline</h2>
			<p>
				Connect to the internet to load your inbox. Previously viewed emails will be available
				offline after your first visit.
			</p>
			<button class="btn" onclick={() => location.reload()}>Try again</button>
		</div>
	</main>
{:else if errorMessage}
	<!-- ── Error state ─────────────────────────────────────────────── -->
	<main class="error-page">
		<div class="error-card">
			<h2>Something went wrong</h2>
			<p>{errorMessage}</p>
			<div class="error-actions">
				<button class="btn" onclick={() => location.reload()}>Try again</button>
				<a href="/login" class="btn-secondary-link">Sign in again</a>
			</div>
		</div>
	</main>
{:else if email}
	<!-- ── Authenticated inbox view ────────────────────────────────── -->
	<div class="app-shell">
		<!-- ── App Header ──────────────────────────────────────────── -->
		<header class="app-header">
			<div class="header-left">
				<img src="/favicon.svg" alt="" class="app-logo" width="40" height="40" />
				<span class="app-name">Switchboard</span>
				{#if !online.current}
					<span class="offline-badge" title="You are offline. Some actions are disabled.">
						Offline
					</span>
				{/if}
			</div>
			<div class="header-center">
				<form
					class="search-form"
					onsubmit={(e) => {
						e.preventDefault();
						handleSearchSubmit();
					}}
				>
					<div class="search-input-wrapper">
						<svg class="search-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
							<path
								d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"
							/>
						</svg>
						<input
							type="text"
							class="search-input"
							placeholder="Search mail"
							bind:value={searchInputValue}
							onkeydown={(e) => {
								if (e.key === 'Escape') {
									if (isSearchActive) clearSearch();
									else searchInputValue = '';
									(e.target as HTMLInputElement).blur();
								}
							}}
							disabled={!online.current}
						/>
						{#if searchInputValue || isSearchActive}
							<button
								type="button"
								class="search-clear"
								onclick={() => {
									if (isSearchActive) clearSearch();
									else searchInputValue = '';
								}}
								title="Clear search"
							>
								<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
									<path
										d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
									/>
								</svg>
							</button>
						{/if}
					</div>
				</form>
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

		<!-- ── Panel Tabs (accessible tablist) ─────────────────────── -->
		<div class="panel-tabs" role="tablist" aria-label="Inbox panels">
			{#each panels as panel, i (i)}
				<button
					class="panel-tab"
					class:active={activePanel === i}
					role="tab"
					aria-selected={activePanel === i}
					aria-controls="panel-{i}"
					id="tab-{i}"
					tabindex={activePanel === i ? 0 : -1}
					onclick={() => switchPanel(i)}
					onkeydown={(e) => {
						/* Arrow keys navigate between tabs (WAI-ARIA Tabs pattern). */
						if (e.key === 'ArrowRight') {
							e.preventDefault();
							const next = (i + 1) % panels.length;
							switchPanel(next);
							/* Focus the newly active tab. */
							(document.getElementById(`tab-${next}`) as HTMLElement)?.focus();
						} else if (e.key === 'ArrowLeft') {
							e.preventDefault();
							const prev = (i - 1 + panels.length) % panels.length;
							switchPanel(prev);
							(document.getElementById(`tab-${prev}`) as HTMLElement)?.focus();
						}
					}}
				>
					<span class="tab-name">{panel.name}</span>
					{#if panelStats[i]?.unread > 0}
						<span class="tab-badge">{panelStats[i].unread}</span>
					{/if}
					{#if activePanel === i && activeAutoFillLoading}
						<span
							class="tab-fetch-dot"
							aria-label="Loading more threads"
							title="Auto-fill: loading more threads from Gmail to fill page {currentPage} ({currentPanelThreads.length} loaded for this panel, need {currentPage *
								pageSize}). {isSearchActive
								? `Search query: "${searchQuery}". `
								: ''}All threads loaded: {isSearchActive
								? searchAllLoaded
								: allThreadsLoaded}. Total loaded across all panels: {activeThreadList.length}."
						></span>
					{/if}
				</button>
			{/each}

			<button class="config-btn" onclick={openConfig} title="Settings">
				<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
					<path
						d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z"
					/>
				</svg>
			</button>
		</div>

		<!-- ── Search Active Indicator Bar ────────────────────────── -->
		{#if isSearchActive}
			<div class="search-active-bar">
				<span class="search-active-label">
					Results for "<strong>{searchQuery}</strong>"
					{#if !searchLoading}
						— {activeThreadList.length} found
					{/if}
				</span>
				<button class="search-active-clear" onclick={clearSearch}>Clear search</button>
			</div>
		{/if}

		<!-- ── Panel Toolbar (Gmail-style) ────────────────────────── -->
		<div class="panel-toolbar">
			<div class="toolbar-left">
				<!-- Master checkbox with dropdown arrow -->
				<div class="select-dropdown-wrapper">
					<label class="toolbar-checkbox">
						<input
							type="checkbox"
							checked={masterCheckState === 'all'}
							indeterminate={masterCheckState === 'some'}
							onchange={toggleMasterCheckbox}
						/>
					</label>
					<button
						class="dropdown-arrow"
						onclick={() => (showSelectDropdown = !showSelectDropdown)}
						title="Select options"
					>
						<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
							<path d="M7 10l5 5 5-5z" />
						</svg>
					</button>
					{#if showSelectDropdown}
						<div class="dropdown-menu">
							<button class="dropdown-item" onclick={selectAll}>All</button>
							<button class="dropdown-item" onclick={selectNone}>None</button>
							<button class="dropdown-item" onclick={selectRead}>Read</button>
							<button class="dropdown-item" onclick={selectUnread}>Unread</button>
						</div>
					{/if}
				</div>

				<!-- Trash button (enabled only with selection) -->
				<button
					class="toolbar-btn"
					disabled={selectedThreads.size === 0 || !online.current}
					onclick={() => (showTrashConfirm = true)}
					title={selectedThreads.size === 0
						? 'Select threads to delete'
						: `Trash ${selectedThreads.size} thread(s)`}
				>
					<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
						<path
							d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
						/>
					</svg>
				</button>

				<!-- Mark Read button (enabled only with selection) -->
				<button
					class="toolbar-btn"
					disabled={selectedThreads.size === 0 || !online.current}
					onclick={handleMarkRead}
					title={selectedThreads.size === 0
						? 'Select threads to mark as read'
						: `Mark ${selectedThreads.size} as read`}
				>
					<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
						<path
							d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8l8 5 8-5v10zm-8-7L4 6h16l-8 5z"
						/>
					</svg>
				</button>

				<!-- Refresh button -->
				<button
					class="toolbar-btn"
					class:spinning={refreshing}
					disabled={!online.current || refreshing}
					onclick={handleRefresh}
					title="Refresh inbox"
				>
					<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
						<path
							d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
						/>
					</svg>
				</button>

				<!-- More options dropdown -->
				<div class="more-dropdown-wrapper">
					<button
						class="toolbar-btn"
						onclick={() => (showMoreDropdown = !showMoreDropdown)}
						title="More actions"
					>
						<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
							<path
								d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"
							/>
						</svg>
					</button>
					{#if showMoreDropdown}
						<div class="dropdown-menu">
							<button class="dropdown-item" onclick={handleMarkAllRead}>
								Mark all as read in this panel
							</button>
						</div>
					{/if}
				</div>
			</div>

			<!-- Pagination controls (right side) -->
			<div class="toolbar-right">
				{#if currentPanelThreads.length > 0}
					<span class="pagination-display">{paginationDisplay}</span>
					<button
						class="toolbar-btn pagination-btn"
						disabled={currentPage <= 1}
						onclick={prevPage}
						title="Previous page"
					>
						<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
							<path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
						</svg>
					</button>
					<button
						class="toolbar-btn pagination-btn"
						disabled={currentPage >= totalPanelPages}
						onclick={nextPage}
						title="Next page"
					>
						<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
							<path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
						</svg>
					</button>
				{/if}
			</div>
		</div>

		<!-- ── Thread List ─────────────────────────────────────────── -->
		<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
		<main id="main-content" class="thread-area" role="tabpanel" aria-labelledby="tab-{activePanel}">
			{#if searchLoading}
				<!-- Search in progress -->
				<div class="threads-loading">
					<div class="spinner small"></div>
					<p>Searching…</p>
				</div>
			{:else if loadingThreads && threadMetaList.length === 0}
				<!-- Loading threads -->
				<div class="threads-loading">
					<div class="spinner small"></div>
					<p>Loading threads…</p>
				</div>
			{:else if currentPanelThreads.length === 0}
				<!-- Empty panel -->
				<div class="empty-panel">
					{#if isSearchActive}
						<p>
							No results for "<strong>{searchQuery}</strong>" in
							<strong>{panels[activePanel]?.name ?? 'this panel'}</strong>.
						</p>
						<p class="empty-hint">
							{#if activeThreadList.length > 0}
								Try checking other panels — {activeThreadList.length} result{activeThreadList.length ===
								1
									? ''
									: 's'} found across all panels.
							{:else}
								Try a different search query.
							{/if}
						</p>
					{:else}
						<p>No threads in <strong>{panels[activePanel]?.name ?? 'this panel'}</strong>.</p>
						<p class="empty-hint">
							{#if threadMetaList.length === 0}
								Your inbox is empty.
							{:else}
								Try adjusting your panel rules to sort threads here.
							{/if}
						</p>
					{/if}
				</div>
			{:else}
				<!-- Thread rows (paginated — only `displayedThreads` are rendered) -->
				<div class="thread-list">
					{#each displayedThreads as thread (thread.id)}
						<div class="thread-row" class:unread={thread.labelIds.includes('UNREAD')}>
							<label class="thread-checkbox">
								<input
									type="checkbox"
									checked={selectedThreads.has(thread.id)}
									onchange={() => toggleThread(thread.id)}
								/>
							</label>

							<a href="/t/{thread.id}" class="thread-link" onclick={() => markAsRead(thread.id)}>
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

				<!-- Bottom UI removed — auto-fill runs silently, tab dot shows loading state. -->
			{/if}
		</main>
	</div>

	<!-- ── Trash Confirmation Modal ──────────────────────────────── -->
	{#if showTrashConfirm}
		<div class="modal-backdrop" onclick={() => (showTrashConfirm = false)} role="presentation">
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="modal trash-modal" onclick={(e) => e.stopPropagation()}>
				<div class="modal-header">
					<h2>Trash {selectedThreads.size} thread{selectedThreads.size === 1 ? '' : 's'}?</h2>
					<button class="modal-close" onclick={() => (showTrashConfirm = false)} title="Close">
						<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
							<path
								d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
							/>
						</svg>
					</button>
				</div>
				<div class="trash-modal-body">
					<p>
						{selectedThreads.size === 1
							? 'This thread will be moved to the trash.'
							: `These ${selectedThreads.size} threads will be moved to the trash.`}
						You can recover trashed emails from Gmail's Trash folder within 30 days.
					</p>
				</div>
				<div class="modal-footer">
					<button class="btn-secondary" onclick={() => (showTrashConfirm = false)}>Cancel</button>
					<button class="btn-danger" disabled={trashLoading} onclick={handleTrash}>
						{trashLoading ? 'Trashing…' : 'Move to trash'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- ── Error Toast (background operation failures) ────────────── -->
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

	<!-- ── Panel Config Modal ──────────────────────────────────────── -->
	{#if showConfig}
		<div class="modal-backdrop" onclick={cancelConfig} role="presentation">
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="modal" onclick={(e) => e.stopPropagation()}>
				<div class="modal-header">
					<h2>Settings</h2>
					<button class="modal-close" onclick={cancelConfig} title="Close">
						<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
							<path
								d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
							/>
						</svg>
					</button>
				</div>

				<!-- ── Modal Scroll Body ───────────────────────── -->
				<div class="modal-scroll-body">
					<!-- ── Configure Panels Section ──────────────── -->
					<h3 class="settings-section-heading">Configure Panels</h3>

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
									<p class="no-rules">No rules — this panel shows all emails.</p>
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

					<!-- ── Page Size Section ─────────────────────── -->
					<div class="settings-section">
						<h3 class="settings-section-heading">Page Size</h3>
						<p class="settings-section-desc">Number of threads shown per page in each panel.</p>
						<div class="config-field">
							<label class="config-label" for="page-size-select">Threads per page</label>
							<select
								id="page-size-select"
								class="rule-select page-size-select"
								bind:value={editingPageSize}
							>
								{#each PAGE_SIZE_OPTIONS as size (size)}
									<option value={size}>{size}</option>
								{/each}
							</select>
						</div>
					</div>

					<!-- ── Diagnostics Section ──────────────────── -->
					<div class="settings-section">
						<h3 class="settings-section-heading">Diagnostics</h3>
						<p class="settings-section-desc">
							View counts, cache stats, connectivity, and service worker status.
						</p>
						<button
							class="diagnostics-link"
							onclick={() => {
								showConfig = false;
								showDebugOverlay = true;
								void loadDiagnostics();
							}}
						>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
								<path
									d="M20 8h-2.81a5.985 5.985 0 00-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"
								/>
							</svg>
							Open Diagnostics (Ctrl+Shift+D)
						</button>
					</div>
				</div>
				<!-- /.modal-scroll-body -->

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
							that tab. Panels with no rules show all emails.
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

					<div class="modal-scroll-body">
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
										<p class="no-rules">No rules — this panel shows all emails.</p>
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
					</div>
					<!-- /.modal-scroll-body -->

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

<!-- ── Diagnostics Overlay (Ctrl+Shift+D) ──────────────────────────── -->
{#if showDebugOverlay}
	<div class="debug-overlay" role="complementary" aria-label="Diagnostics">
		<div class="debug-header">
			<span class="debug-title">Diagnostics</span>
			<button
				class="debug-close"
				onclick={() => (showDebugOverlay = false)}
				title="Close (Ctrl+Shift+D)"
			>
				&times;
			</button>
		</div>

		<!-- Tab bar -->
		<div class="debug-tabs">
			<button
				class="debug-tab"
				class:debug-tab-active={debugTab === 'counts'}
				onclick={() => (debugTab = 'counts')}
			>
				Counts
			</button>
			<button
				class="debug-tab"
				class:debug-tab-active={debugTab === 'system'}
				onclick={() => {
					debugTab = 'system';
					void loadDiagnostics();
				}}
			>
				System
			</button>
		</div>

		<div class="debug-body">
			{#if debugTab === 'counts'}
				<!-- ── Counts Tab ── -->
				<div class="debug-section">
					<div class="debug-label">Context</div>
					<div class="debug-value">{isSearchActive ? `Search: "${searchQuery}"` : 'Inbox'}</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">Active Panel</div>
					<div class="debug-value">{panels[activePanel]?.name ?? '?'} (#{activePanel})</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">Server Counts Available</div>
					<div class="debug-value">{panelCountEstimates ? 'Yes' : 'No (suppressing badges)'}</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">All Threads Loaded</div>
					<div class="debug-value">{isSearchActive ? searchAllLoaded : allThreadsLoaded}</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">Auto-Fill Active</div>
					<div class="debug-value">{activeAutoFillLoading}</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">Page Size</div>
					<div class="debug-value">{pageSize}</div>
				</div>
				<div class="debug-divider"></div>
				<table class="debug-table">
					<thead>
						<tr>
							<th>Panel</th>
							<th>Loaded</th>
							<th>Srv Total</th>
							<th>Srv Unread</th>
							<th>Exact?</th>
							<th>Badge</th>
						</tr>
					</thead>
					<tbody>
						{#each panels as panel, i (panel.name)}
							<tr class:debug-active-row={activePanel === i}>
								<td>{panel.name}</td>
								<td>{panelStats[i]?.total ?? 0}</td>
								<td>{panelCountEstimates?.[i]?.total ?? '—'}</td>
								<td>{panelCountEstimates?.[i]?.unread ?? '—'}</td>
								<td
									>{panelCountEstimates?.[i]
										? panelCountEstimates[i].isEstimate
											? '~est'
											: 'exact'
										: '—'}</td
								>
								<td>{panelStats[i]?.unread ?? 0}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<div class="debug-divider"></div>
				<div class="debug-section">
					<div class="debug-label">Pagination Display</div>
					<div class="debug-value">{paginationDisplay}</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">Total Pages</div>
					<div class="debug-value">{totalPanelPages}</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">Current Page</div>
					<div class="debug-value">{currentPage}</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">Loaded (all)</div>
					<div class="debug-value">{activeThreadList.length} threads</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">Loaded (this panel)</div>
					<div class="debug-value">{currentPanelThreads.length} threads</div>
				</div>
			{:else}
				<!-- ── System Tab ── -->
				<div class="debug-section">
					<div class="debug-label">Connectivity</div>
					<div
						class="debug-value"
						class:debug-online={online.current}
						class:debug-offline={!online.current}
					>
						{online.current ? 'Online' : 'Offline'}
					</div>
				</div>
				<div class="debug-divider"></div>
				<div class="debug-section">
					<div class="debug-label">Cached metadata</div>
					<div class="debug-value">{diagMetaCount}</div>
				</div>
				<div class="debug-section">
					<div class="debug-label">Cached details</div>
					<div class="debug-value">{diagDetailCount}</div>
				</div>
				<div class="debug-actions">
					<button
						class="debug-btn debug-btn-danger"
						onclick={handleDiagClearCaches}
						disabled={diagClearing || diagResetting}
					>
						{diagClearing ? 'Clearing...' : 'Clear caches'}
					</button>
					<button
						class="debug-btn debug-btn-nuclear"
						onclick={handleDiagFactoryReset}
						disabled={diagResetting || diagClearing}
						title="Clears IndexedDB, localStorage, SW caches, and reloads. Auth cookies preserved."
					>
						{diagResetting ? 'Resetting...' : 'Factory reset'}
					</button>
				</div>
				<div class="debug-divider"></div>
				<div class="debug-section">
					<div class="debug-label">Service Worker</div>
					<div class="debug-value">{diagSwStatus}</div>
				</div>
				{#if diagSwUpdateAvailable}
					<div class="debug-actions">
						<button class="debug-btn debug-btn-primary" onclick={handleDiagForceSwUpdate}>
							Force update SW
						</button>
					</div>
				{/if}
				{#if diagActionMessage}
					<div class="debug-feedback" role="status">{diagActionMessage}</div>
				{/if}
			{/if}
			<div class="debug-hint">Ctrl+Shift+D to toggle</div>
		</div>
	</div>
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

	/* ── Offline state (graceful, not error) ──────────────────────── */
	.offline-page {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
	}

	.offline-card {
		background: var(--color-bg-surface);
		border: 1px solid var(--color-warning-border);
		border-radius: 8px;
		padding: 40px;
		text-align: center;
		max-width: 420px;
	}

	.offline-icon {
		color: var(--color-text-tertiary);
		margin-bottom: 16px;
	}

	.offline-card h2 {
		margin: 0 0 8px;
		font-size: 18px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.offline-card p {
		color: var(--color-text-secondary);
		margin: 0 0 24px;
		font-size: 14px;
		line-height: 1.5;
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
		gap: 8px;
	}

	.app-logo {
		flex-shrink: 0;
		display: block;
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

	/* ── Panel Toolbar (Gmail-style action bar above thread list) ─── */
	.panel-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 8px;
		background: var(--color-bg-surface);
		border-bottom: 1px solid var(--color-border-subtle);
		min-height: 44px;
		gap: 4px;
	}

	.toolbar-left {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.toolbar-right {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.toolbar-checkbox {
		display: flex;
		align-items: center;
		padding: 6px;
		cursor: pointer;
	}

	.toolbar-checkbox input[type='checkbox'] {
		width: 18px;
		height: 18px;
		cursor: pointer;
		accent-color: var(--color-primary);
	}

	.toolbar-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 7px;
		background: none;
		border: none;
		border-radius: 50%;
		cursor: pointer;
		color: var(--color-text-secondary);
		transition:
			background 0.15s,
			color 0.15s;
	}

	.toolbar-btn:hover:not(:disabled) {
		background: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	.toolbar-btn:disabled {
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}

	/* Spinning animation for the refresh button. */
	.toolbar-btn.spinning svg {
		animation: spin 0.8s linear infinite;
	}

	.pagination-display {
		font-size: 12px;
		color: var(--color-text-secondary);
		padding: 0 4px;
		white-space: nowrap;
	}

	.pagination-btn {
		padding: 6px;
	}

	/* ── Dropdown Menus (multiselect + more options) ──────────────── */
	.select-dropdown-wrapper,
	.more-dropdown-wrapper {
		position: relative;
		display: flex;
		align-items: center;
	}

	.dropdown-arrow {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4px 2px;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-secondary);
		border-radius: 4px;
	}

	.dropdown-arrow:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	.dropdown-menu {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 50;
		background: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		box-shadow: var(--color-shadow-lg);
		min-width: 160px;
		padding: 4px 0;
		margin-top: 2px;
	}

	.dropdown-item {
		display: block;
		width: 100%;
		padding: 8px 16px;
		font-size: 13px;
		color: var(--color-text-primary);
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		font-family: inherit;
	}

	.dropdown-item:hover {
		background: var(--color-bg-hover-alt);
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

	/* ── Tab Fetch Dot ─────────────────────────────────────────────── */
	/* Minimal pulsing dot — indicates background fetch in progress */
	.tab-fetch-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-primary);
		animation: tab-pulse 1.4s ease-in-out infinite;
		flex-shrink: 0;
	}

	@keyframes tab-pulse {
		0%,
		100% {
			opacity: 0.25;
			transform: scale(0.75);
		}
		50% {
			opacity: 0.85;
			transform: scale(1);
		}
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

	/* ── Modal Scroll Body ─────────────────────────────────────────── */
	/* Single scroll container for settings/onboarding modal content. */
	.modal-scroll-body {
		overflow-y: auto;
		flex: 1;
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

	/* ── Trash Confirmation Modal ─────────────────────────────────── */
	.trash-modal {
		width: 420px;
	}

	.trash-modal-body {
		padding: 16px 24px;
	}

	.trash-modal-body p {
		font-size: 14px;
		color: var(--color-text-secondary);
		margin: 0;
		line-height: 1.5;
	}

	.btn-danger {
		padding: 8px 20px;
		font-size: 14px;
		color: #fff;
		background: var(--color-error);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
		font-weight: 500;
	}

	.btn-danger:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn-danger:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	/* ── Search Bar (Header) ──────────────────────────────────────── */
	.header-center {
		flex: 1;
		max-width: 720px;
		margin: 0 16px;
	}

	.search-form {
		width: 100%;
	}

	.search-input-wrapper {
		display: flex;
		align-items: center;
		background: var(--color-bg-surface-dim);
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 0 8px;
		transition:
			background 0.2s,
			border-color 0.2s,
			box-shadow 0.2s;
	}

	.search-input-wrapper:focus-within {
		background: var(--color-bg-surface);
		border-color: var(--color-primary);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.search-icon {
		flex-shrink: 0;
		color: var(--color-text-tertiary);
		margin-right: 8px;
	}

	.search-input {
		flex: 1;
		padding: 10px 4px;
		border: none;
		background: none;
		font-size: 16px;
		font-family: inherit;
		color: var(--color-text-primary);
		outline: none;
	}

	.search-input::placeholder {
		color: var(--color-text-tertiary);
	}

	.search-input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.search-clear {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4px;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-secondary);
		border-radius: 50%;
	}

	.search-clear:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	/* ── Search Active Bar ────────────────────────────────────────── */
	.search-active-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		background: var(--color-bg-hover-alt);
		border-bottom: 1px solid var(--color-border);
		font-size: 13px;
		color: var(--color-text-secondary);
	}

	.search-active-label strong {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.search-active-clear {
		padding: 4px 12px;
		font-size: 12px;
		color: var(--color-primary);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
	}

	.search-active-clear:hover {
		background: var(--color-bg-surface);
		border-color: var(--color-primary);
	}

	/* ── Settings Modal Sections ──────────────────────────────────── */
	.settings-section {
		padding: 16px 24px;
		border-top: 1px solid var(--color-border);
	}

	.settings-section-heading {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0 0 4px;
		padding: 12px 24px 0;
	}

	.settings-section .settings-section-heading {
		padding: 0;
	}

	.settings-section-desc {
		font-size: 13px;
		color: var(--color-text-secondary);
		margin: 0 0 12px;
	}

	.page-size-select {
		width: 120px;
	}

	.diagnostics-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--color-primary);
		text-decoration: none;
		font-size: 14px;
		font-family: inherit;
		padding: 8px 12px;
		border-radius: 4px;
		border: 1px solid var(--color-border);
		background: none;
		cursor: pointer;
	}

	.diagnostics-link:hover {
		background: var(--color-bg-surface);
		border-color: var(--color-primary);
		text-decoration: none;
	}

	/* ── Responsive: Tablet (768px) ──────────────────────────────── */
	@media (max-width: 768px) {
		.user-email {
			display: none;
		}

		.header-center {
			margin: 0 8px;
		}

		.panel-tab {
			padding: 14px 12px;
			font-size: 13px;
		}

		.thread-from {
			min-width: 80px;
			max-width: 100px;
			width: auto;
		}
	}

	/* ── Responsive: Mobile (480px) ──────────────────────────────── */
	@media (max-width: 480px) {
		.app-header {
			flex-wrap: wrap;
			height: auto;
			padding: 8px 12px;
			gap: 8px;
		}

		.header-center {
			order: 3;
			flex-basis: 100%;
			margin: 0;
		}

		.header-left {
			flex: 1;
		}

		.header-right {
			flex-shrink: 0;
		}

		.sign-out-btn {
			padding: 6px 12px;
			font-size: 13px;
		}

		.panel-tab {
			padding: 12px 10px;
			font-size: 12px;
		}

		.toolbar-left,
		.toolbar-right {
			gap: 4px;
		}

		.thread-from {
			min-width: 60px;
			max-width: 80px;
			width: auto;
		}

		.thread-date {
			font-size: 11px;
		}

		.search-active-bar {
			flex-direction: column;
			gap: 4px;
			align-items: flex-start;
		}
	}

	/* ── Debug Overlay (Ctrl+Shift+D) ─────────────────────────────── */
	/* ── Diagnostics Overlay ──────────────────────────────────────── */
	.debug-overlay {
		position: fixed;
		bottom: 16px;
		right: 16px;
		z-index: 9999;
		width: 420px;
		max-height: 70vh;
		display: flex;
		flex-direction: column;
		background: var(--color-bg-surface);
		border: 2px solid var(--color-primary);
		border-radius: 8px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
		font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
		font-size: 12px;
	}

	.debug-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		background: var(--color-primary);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		border-radius: 6px 6px 0 0;
	}

	.debug-close {
		background: none;
		border: none;
		color: #fff;
		font-size: 18px;
		cursor: pointer;
		padding: 0 4px;
		line-height: 1;
	}

	.debug-close:hover {
		opacity: 0.7;
	}

	.debug-tabs {
		display: flex;
		border-bottom: 1px solid var(--color-border);
	}

	.debug-tab {
		flex: 1;
		padding: 6px 0;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--color-text-secondary);
		font-family: inherit;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.debug-tab:hover {
		color: var(--color-text-primary);
		background: var(--color-bg-hover);
	}

	.debug-tab-active {
		color: var(--color-primary);
		border-bottom-color: var(--color-primary);
	}

	.debug-body {
		padding: 10px 12px;
		overflow-y: auto;
		flex: 1;
	}

	.debug-section {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 3px 0;
	}

	.debug-label {
		color: var(--color-text-secondary);
		font-size: 11px;
	}

	.debug-value {
		color: var(--color-text-primary);
		font-weight: 500;
		font-size: 11px;
		text-align: right;
		max-width: 55%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.debug-online {
		color: #34a853;
	}

	.debug-offline {
		color: var(--color-warning);
	}

	.debug-divider {
		height: 1px;
		background: var(--color-border);
		margin: 6px 0;
	}

	.debug-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 11px;
	}

	.debug-table th {
		text-align: left;
		color: var(--color-text-secondary);
		font-weight: 500;
		padding: 3px 4px;
		border-bottom: 1px solid var(--color-border);
	}

	.debug-table td {
		padding: 3px 4px;
		color: var(--color-text-primary);
	}

	.debug-active-row {
		background: var(--color-bg-hover);
		font-weight: 600;
	}

	.debug-actions {
		display: flex;
		gap: 6px;
		margin: 6px 0;
	}

	.debug-btn {
		padding: 4px 10px;
		font-size: 11px;
		font-family: inherit;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		color: #fff;
	}

	.debug-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.debug-btn-danger {
		background: var(--color-error);
	}

	.debug-btn-danger:hover:not(:disabled) {
		opacity: 0.9;
	}

	.debug-btn-nuclear {
		background: #b91c1c;
	}

	.debug-btn-nuclear:hover:not(:disabled) {
		background: #991b1b;
	}

	.debug-btn-primary {
		background: var(--color-primary);
	}

	.debug-btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.debug-feedback {
		padding: 4px 8px;
		margin-top: 6px;
		font-size: 11px;
		color: var(--color-text-primary);
		background: var(--color-bg-hover);
		border-radius: 3px;
		text-align: center;
	}

	.debug-hint {
		text-align: center;
		color: var(--color-text-muted);
		font-size: 10px;
		margin-top: 6px;
		opacity: 0.6;
	}
</style>
