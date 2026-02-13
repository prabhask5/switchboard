/**
 * @fileoverview Pure UI utility functions extracted from Svelte components.
 *
 * These functions were originally defined inline within Svelte components,
 * making them untestable via direct import. Extracting them here enables:
 *   - Direct import in unit tests (no need for re-implementations)
 *   - Reuse across multiple components
 *   - Cleaner component files
 *
 * Functions are grouped by their source component:
 *
 * **From `src/routes/+page.svelte` (Inbox Page):**
 *   - {@link reconstructFrom} — Reconstructs raw From header for rule matching
 *   - {@link masterCheckState} — Toolbar checkbox state computation
 *   - {@link loadPanels} — Load panel config from localStorage
 *   - {@link savePanels} — Save panel config to localStorage
 *   - {@link isFirstTimeUser} — Check if user has saved panel config
 *   - {@link loadPageSize} — Load page size from localStorage
 *   - {@link savePageSize} — Save page size to localStorage
 *   - {@link PAGE_SIZE_OPTIONS} — Valid page size options constant
 *   - {@link buildThreadsUrl} — Construct /api/threads URL with params
 *   - {@link computePaginationDisplay} — Gmail-style pagination string
 *   - {@link computeTotalPanelPages} — Total pages from loaded + estimate
 *   - {@link computePanelStats} — Per-panel total/unread with estimates
 *   - {@link decrementUnreadCounts} — Optimistic unread decrement
 *
 * **From `src/routes/t/[threadId]/+page.svelte` (Thread Detail):**
 *   - {@link senderDisplay} — Display name from sender
 *   - {@link formatFileSize} — Human-readable file size
 *   - {@link attachmentUrl} — Attachment download URL
 *   - {@link getAttachmentIcon} — File extension to icon category
 *   - {@link EXT_TO_TYPE} — Extension → icon type mapping
 */

import type { PanelConfig, AttachmentInfo, PanelCount } from './types.js';
import { threadMatchesPanel, getDefaultPanels } from './rules.js';

// =============================================================================
// Constants
// =============================================================================

/** localStorage key for persisting panel configurations. */
const PANELS_STORAGE_KEY = 'switchboard_panels';

/** localStorage key for persisting page size preference. */
const PAGE_SIZE_KEY = 'switchboard_page_size';

/**
 * Valid page size options for the settings dropdown.
 * Used by {@link loadPageSize} to validate stored values.
 */
export const PAGE_SIZE_OPTIONS = [10, 15, 20, 25, 50, 100] as const;

// =============================================================================
// From Header Reconstruction (from +page.svelte)
// =============================================================================

/**
 * Reconstructs the raw From header string from parsed `{name, email}` parts.
 *
 * Needed for rule matching, which operates on the raw header value
 * (e.g., `"John Doe <john@example.com>"`). The parsed parts are stored
 * separately in `ThreadMetadata` for display purposes.
 *
 * @param thread - Object with a parsed `from` field.
 * @returns The reconstructed raw From header string.
 *
 * @example
 * ```typescript
 * reconstructFrom({ from: { name: 'John', email: 'john@x.com' } });
 * // → "John <john@x.com>"
 *
 * reconstructFrom({ from: { name: '', email: 'john@x.com' } });
 * // → "john@x.com"
 * ```
 */
export function reconstructFrom(thread: { from: { name: string; email: string } }): string {
	if (thread.from.name) {
		return `${thread.from.name} <${thread.from.email}>`;
	}
	return thread.from.email;
}

// =============================================================================
// Master Checkbox State (from +page.svelte)
// =============================================================================

/**
 * Computes the state of the toolbar master checkbox.
 *
 * Returns `'all'` when every displayed thread is selected, `'some'` when
 * at least one (but not all) is selected, and `'none'` when none are.
 * Selected IDs not in the displayed threads are ignored (they may be
 * from other pages).
 *
 * @param displayedThreads - Threads currently visible on the page.
 * @param selectedThreadIds - The full set of selected thread IDs.
 * @returns The checkbox state: `'all'`, `'some'`, or `'none'`.
 *
 * @example
 * ```typescript
 * masterCheckState([{ id: 'a' }, { id: 'b' }], new Set(['a', 'b']));
 * // → 'all'
 * ```
 */
export function masterCheckState(
	displayedThreads: { id: string }[],
	selectedThreadIds: Set<string>
): 'all' | 'some' | 'none' {
	if (displayedThreads.length === 0) return 'none';
	const selectedOnPage = displayedThreads.filter((t) => selectedThreadIds.has(t.id)).length;
	if (selectedOnPage === 0) return 'none';
	if (selectedOnPage === displayedThreads.length) return 'all';
	return 'some';
}

// =============================================================================
// Panel localStorage Helpers (from +page.svelte)
// =============================================================================

/**
 * Loads panel configuration from localStorage.
 *
 * Falls back to {@link getDefaultPanels} if nothing is stored, the data
 * is corrupted JSON, the parsed value is not an array, or the array is
 * empty. Automatically migrates old regex-based panel rules to the new
 * address list format via {@link migrateOldPanelFormat}.
 *
 * @param storage - The Storage interface to read from (enables testing
 *   without mocking `window.localStorage`).
 * @returns The parsed panel configurations, or defaults.
 */
export function loadPanels(storage: Storage): PanelConfig[] {
	try {
		const saved = storage.getItem(PANELS_STORAGE_KEY);
		if (saved) {
			const parsed = JSON.parse(saved);
			if (Array.isArray(parsed) && parsed.length > 0) {
				/* Migrate old regex-based format if needed. */
				return migrateOldPanelFormat(parsed);
			}
		}
	} catch {
		/* Corrupted localStorage data — fall back to defaults. */
	}
	return getDefaultPanels();
}

/**
 * Migrates old regex-based panel rules to the new address list format.
 *
 * Detects old format by checking for a `pattern` key on rules. Rules that
 * already have `addresses` are passed through unchanged. Best-effort:
 * strips regex metacharacters, splits on `|` for alternatives, expands
 * `(a|b)` groups with surrounding text.
 *
 * @param panels - Raw parsed panel array from localStorage.
 * @returns Array of PanelConfig objects with `addresses` arrays.
 *
 * @example
 * ```typescript
 * // Old format:
 * migrateOldPanelFormat([{
 *   name: 'Work',
 *   rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
 * }]);
 * // → [{ name: 'Work', rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }] }]
 * ```
 */
export function migrateOldPanelFormat(panels: any[]): PanelConfig[] {
	return panels.map((panel) => ({
		name: panel.name ?? 'Panel',
		rules: (panel.rules ?? []).map((rule: any) => {
			/* Detect old regex format: has `pattern` but no `addresses`. */
			if ('pattern' in rule && !('addresses' in rule)) {
				return {
					field: rule.field ?? 'from',
					addresses: patternToAddresses(rule.pattern ?? ''),
					action: rule.action ?? 'accept'
				};
			}
			/* Already in new format or unknown — pass through with defaults. */
			return {
				field: rule.field ?? 'from',
				addresses: rule.addresses ?? [],
				action: rule.action ?? 'accept'
			};
		})
	}));
}

/**
 * Best-effort conversion from a regex pattern string to address list.
 *
 * Handles common patterns:
 *   - `@company\.com` → `['@company.com']`
 *   - `@(twitter|facebook)\.com` → `['@twitter.com', '@facebook.com']`
 *   - `newsletter|digest` → `['newsletter', 'digest']`
 *
 * Strips anchors (`^`, `$`), quantifiers, character classes, and
 * unescapes backslash sequences. This is lossy but good enough for
 * a one-time migration of existing user rules.
 *
 * @param pattern - The regex pattern string to convert.
 * @returns Array of address/domain strings.
 */
export function patternToAddresses(pattern: string): string[] {
	if (!pattern.trim()) return [];
	let clean = pattern.replace(/[\^$]/g, '');

	/*
	 * Handle (a|b) groups with surrounding text.
	 * e.g., "@(twitter|facebook)\.com" → ["@twitter.com", "@facebook.com"]
	 */
	const groupMatch = clean.match(/\(([^)]+)\)/);
	if (groupMatch && groupMatch.index !== undefined) {
		const prefix = clean.slice(0, groupMatch.index);
		const suffix = clean.slice(groupMatch.index + groupMatch[0].length);
		const alts = groupMatch[1].split('|');
		return alts
			.map((alt) =>
				(prefix + alt + suffix)
					.replace(/\\(.)/g, '$1') /* Unescape: \. → . */
					.replace(/[*+?{}[\]]/g, '') /* Remove quantifiers/classes */
					.trim()
			)
			.filter(Boolean);
	}

	/* Handle top-level | alternatives. */
	if (clean.includes('|')) {
		return clean
			.split('|')
			.map((s) =>
				s
					.replace(/\\(.)/g, '$1')
					.replace(/[*+?{}[\]]/g, '')
					.trim()
			)
			.filter(Boolean);
	}

	/* Single pattern — unescape and clean. */
	const addr = clean
		.replace(/\\(.)/g, '$1')
		.replace(/[*+?{}[\]]/g, '')
		.trim();
	return addr ? [addr] : [];
}

/**
 * Persists panel configuration to localStorage as JSON.
 *
 * Silently catches errors (e.g., `QuotaExceededError` when localStorage
 * is full) so a failed save never crashes the app.
 *
 * @param storage - The Storage interface to write to.
 * @param p - The panel configurations to persist.
 */
export function savePanels(storage: Storage, p: PanelConfig[]): void {
	try {
		storage.setItem(PANELS_STORAGE_KEY, JSON.stringify(p));
	} catch {
		/* localStorage full or unavailable — silently ignore. */
	}
}

/**
 * Returns true if the user has never saved panel config (first-time user).
 *
 * Used to trigger the onboarding wizard. Checks for the existence of the
 * storage key, not its validity — even corrupted data means the user has
 * been here before.
 *
 * @param storage - The Storage interface to check.
 * @returns `true` if no panel config key exists.
 */
export function isFirstTimeUser(storage: Storage): boolean {
	return storage.getItem(PANELS_STORAGE_KEY) === null;
}

// =============================================================================
// Page Size localStorage Helpers (from +page.svelte)
// =============================================================================

/**
 * Loads page size from localStorage with validation.
 *
 * Returns 20 (the default) if no valid value is stored. A value is valid
 * only if it exactly matches one of the {@link PAGE_SIZE_OPTIONS}.
 *
 * @param storage - The Storage interface to read from.
 * @returns The validated page size, or 20 as the default.
 */
export function loadPageSize(storage: Storage): number {
	try {
		const saved = storage.getItem(PAGE_SIZE_KEY);
		if (saved) {
			const val = Number(saved);
			if (PAGE_SIZE_OPTIONS.includes(val as (typeof PAGE_SIZE_OPTIONS)[number])) return val;
		}
	} catch {
		/* localStorage unavailable — use default. */
	}
	return 20;
}

/**
 * Persists page size to localStorage.
 *
 * Silently catches errors so a failed save never crashes the app.
 *
 * @param storage - The Storage interface to write to.
 * @param size - The page size to persist.
 */
export function savePageSize(storage: Storage, size: number): void {
	try {
		storage.setItem(PAGE_SIZE_KEY, String(size));
	} catch {
		/* localStorage full or unavailable — silently ignore. */
	}
}

// =============================================================================
// URL Construction (from +page.svelte)
// =============================================================================

/**
 * Constructs the `/api/threads` URL with optional query parameters.
 *
 * Used by the inbox page's `fetchThreadPage()` to build the thread listing
 * URL. Omits parameters that are falsy (undefined or empty string).
 *
 * @param pageToken - Pagination token for loading subsequent pages.
 * @param q - Gmail search query string.
 * @returns The constructed URL string.
 *
 * @example
 * ```typescript
 * buildThreadsUrl();
 * // → "/api/threads"
 *
 * buildThreadsUrl('nextPage123', 'from:alice');
 * // → "/api/threads?pageToken=nextPage123&q=from%3Aalice"
 * ```
 */
export function buildThreadsUrl(pageToken?: string, q?: string): string {
	const params = new URLSearchParams();
	if (pageToken) params.set('pageToken', pageToken);
	if (q) params.set('q', q);
	return params.toString() ? `/api/threads?${params.toString()}` : '/api/threads';
}

// =============================================================================
// Pagination Display (from +page.svelte)
// =============================================================================

/**
 * Computes the Gmail-style pagination display string.
 *
 * Display strategy:
 *   - All threads loaded → exact: `"1–20 of 500"`
 *   - Server count with `isEstimate: false` → exact: `"1–20 of 500"`
 *   - Server count with `isEstimate: true` → approximate: `"1–20 of ~500"`
 *   - No server data → loaded count: `"1–20 of 47"`
 *
 * Uses en-dash (U+2013) as the range separator, matching Gmail's style.
 * Large numbers are formatted with locale separators (e.g., `"12,345"`).
 *
 * @param loaded - Total number of loaded threads in the current panel.
 * @param currentPage - The current 1-based page number.
 * @param pageSize - Number of threads per page.
 * @param allLoaded - Whether all server threads have been fetched.
 * @param panelCount - Server-provided count estimate for the panel, or null.
 * @returns The formatted pagination string (e.g., `"1–20 of ~500"`).
 */
export function computePaginationDisplay(
	loaded: number,
	currentPage: number,
	pageSize: number,
	allLoaded: boolean,
	panelCount: PanelCount | null
): string {
	if (loaded === 0) return '0 of 0';
	const start = (currentPage - 1) * pageSize + 1;
	const end = Math.min(currentPage * pageSize, loaded);

	/* If all pages loaded, loaded count is exact — use directly, no tilde. */
	if (allLoaded) return `${start}\u2013${end} of ${loaded.toLocaleString()}`;

	/* Use server counts as source of truth when available. */
	if (panelCount) {
		const displayTotal = Math.max(panelCount.total, loaded);
		const formatted = displayTotal.toLocaleString();
		const total = panelCount.isEstimate ? `~${formatted}` : formatted;
		return `${start}\u2013${end} of ${total}`;
	}

	/* Fallback: use loaded count only when server estimates unavailable. */
	return `${start}\u2013${end} of ${loaded.toLocaleString()}`;
}

// =============================================================================
// Total Panel Pages (from +page.svelte)
// =============================================================================

/**
 * Computes the total number of pages for a panel.
 *
 * Uses the server estimate to enable forward pagination beyond loaded
 * threads. When all threads are loaded, uses the exact loaded count.
 * Always returns at least 1 page.
 *
 * @param loadedCount - Number of loaded threads in the panel.
 * @param pageSize - Number of threads per page.
 * @param allLoaded - Whether all server threads have been fetched.
 * @param estimateTotal - Server estimate of total threads (optional).
 * @returns The total number of pages (minimum 1).
 */
export function computeTotalPanelPages(
	loadedCount: number,
	pageSize: number,
	allLoaded: boolean,
	estimateTotal: number | undefined
): number {
	if (allLoaded) return Math.max(1, Math.ceil(loadedCount / pageSize));
	const total = estimateTotal && estimateTotal > loadedCount ? estimateTotal : loadedCount;
	return Math.max(1, Math.ceil(total / pageSize));
}

// =============================================================================
// Panel Stats Computation (from +page.svelte)
// =============================================================================

/**
 * Minimal thread interface for panel stats computation.
 * Uses a narrow type rather than full `ThreadMetadata` to avoid tight coupling.
 */
interface ThreadForStats {
	/** Parsed sender information. */
	from: { name: string; email: string };
	/** Recipient email(s) from the To header. */
	to: string;
	/** Gmail label IDs (e.g., `["INBOX", "UNREAD"]`). */
	labelIds: string[];
}

/**
 * Computes per-panel statistics: total thread count and unread count.
 *
 * Uses `threadMatchesPanel` to check each thread against EVERY panel
 * (not just assigned to one), allowing threads to appear in multiple panels.
 *
 * Unread badge strategy to prevent flicker:
 *   - Before server estimates arrive (`panelCountEstimates` is null):
 *     suppress badges (show 0 unread).
 *   - After estimates arrive: use server unread counts exclusively.
 *   - When all threads loaded: use exact loaded counts.
 *
 * @param panels - The current panel configurations.
 * @param threads - All loaded threads in the active list.
 * @param allLoaded - Whether all server threads have been fetched.
 * @param panelCountEstimates - Server count estimates, or null if not yet fetched.
 * @returns Array of `{ total, unread }` per panel.
 */
export function computePanelStats(
	panels: PanelConfig[],
	threads: ThreadForStats[],
	allLoaded: boolean,
	panelCountEstimates: PanelCount[] | null
): Array<{ total: number; unread: number }> {
	/* Count from loaded threads as baseline for totals. */
	const loadedStats = panels.map(() => ({ total: 0, unread: 0 }));
	for (const thread of threads) {
		const fromRaw = reconstructFrom(thread);
		for (let i = 0; i < panels.length; i++) {
			if (threadMatchesPanel(panels[i], fromRaw, thread.to)) {
				loadedStats[i].total++;
				if (thread.labelIds.includes('UNREAD')) loadedStats[i].unread++;
			}
		}
	}

	/* If auto-fill loaded everything, loaded counts are exact. */
	if (allLoaded) return loadedStats;

	/* If server estimates haven't arrived, suppress unread badges. */
	if (!panelCountEstimates) {
		return loadedStats.map((s) => ({ total: s.total, unread: 0 }));
	}

	/* Merge server estimates with loaded data. */
	return loadedStats.map((loaded, i) => {
		const est = panelCountEstimates![i];
		if (!est) return { total: loaded.total, unread: 0 };
		return {
			total: Math.max(est.total, loaded.total),
			unread: est.unread
		};
	});
}

// =============================================================================
// Unread Count Decrement (from +page.svelte)
// =============================================================================

/**
 * Optimistically decrements unread counts for panels after a mark-as-read
 * action.
 *
 * Returns null if estimates are null (pass-through). Clamps to zero so
 * unread counts never go negative.
 *
 * @param estimates - Current panel count estimates, or null.
 * @param panelUnreadDecrements - Number of unreads to subtract per panel.
 * @returns Updated estimates with decremented unread counts, or null.
 */
export function decrementUnreadCounts(
	estimates: PanelCount[] | null,
	panelUnreadDecrements: number[]
): PanelCount[] | null {
	if (!estimates) return null;
	return estimates.map((c, i) => ({
		...c,
		unread: Math.max(0, c.unread - (panelUnreadDecrements[i] ?? 0))
	}));
}

// =============================================================================
// Sender Display (from t/[threadId]/+page.svelte)
// =============================================================================

/**
 * Returns a display name for the sender of a message.
 *
 * Shows the name if available, otherwise extracts the local part of the
 * email address (everything before the first `@`). Falls back to the
 * full email string for malformed addresses.
 *
 * @param msg - Object with a parsed `from` field.
 * @returns The display name string.
 *
 * @example
 * ```typescript
 * senderDisplay({ from: { name: 'Alice', email: 'alice@x.com' } });
 * // → "Alice"
 *
 * senderDisplay({ from: { name: '', email: 'bob@example.com' } });
 * // → "bob"
 * ```
 */
export function senderDisplay(msg: { from: { name: string; email: string } }): string {
	if (msg.from.name) return msg.from.name;
	const atIdx = msg.from.email.indexOf('@');
	return atIdx > 0 ? msg.from.email.slice(0, atIdx) : msg.from.email;
}

// =============================================================================
// File Size Formatting (from t/[threadId]/+page.svelte)
// =============================================================================

/**
 * Formats a file size in bytes to a human-readable string.
 *
 * Uses binary units (1 KB = 1024 bytes). Values below 10 in a given unit
 * show one decimal place (e.g., `"1.5 KB"`), larger values are rounded
 * to integers (e.g., `"12 KB"`). Caps at GB (no TB unit).
 *
 * @param bytes - The file size in bytes.
 * @returns Formatted string like `"0 B"`, `"1.5 KB"`, `"3.3 MB"`, etc.
 */
export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const k = 1024;
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
	const val = bytes / Math.pow(k, i);
	return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

// =============================================================================
// Attachment URL (from t/[threadId]/+page.svelte)
// =============================================================================

/**
 * Builds the download URL for a single email attachment.
 *
 * Points to the `GET /api/thread/[id]/attachment` endpoint with all
 * required query parameters. The thread ID is URI-encoded in the path
 * segment; other parameters are encoded via `URLSearchParams`.
 *
 * @param threadId - The Gmail thread ID.
 * @param att - The attachment info object.
 * @returns The full URL for downloading the attachment.
 */
export function attachmentUrl(threadId: string, att: AttachmentInfo): string {
	const params = new URLSearchParams({
		messageId: att.messageId,
		attachmentId: att.attachmentId,
		filename: att.filename,
		mimeType: att.mimeType
	});
	return `/api/thread/${encodeURIComponent(threadId)}/attachment?${params.toString()}`;
}

// =============================================================================
// Attachment Icon Mapping (from t/[threadId]/+page.svelte)
// =============================================================================

/**
 * Maps file extensions to their icon type category.
 *
 * Used by {@link getAttachmentIcon} to determine which icon to display
 * for an attachment. Categories include: `pdf`, `word`, `spreadsheet`,
 * `presentation`, `image`, `video`, `audio`, `archive`, `text`, `code`.
 */
export const EXT_TO_TYPE: Record<string, string> = {
	pdf: 'pdf',
	doc: 'word',
	docx: 'word',
	xls: 'spreadsheet',
	xlsx: 'spreadsheet',
	ppt: 'presentation',
	pptx: 'presentation',
	jpg: 'image',
	jpeg: 'image',
	png: 'image',
	gif: 'image',
	webp: 'image',
	svg: 'image',
	bmp: 'image',
	ico: 'image',
	mp4: 'video',
	mov: 'video',
	avi: 'video',
	mkv: 'video',
	webm: 'video',
	mp3: 'audio',
	wav: 'audio',
	ogg: 'audio',
	flac: 'audio',
	aac: 'audio',
	zip: 'archive',
	rar: 'archive',
	'7z': 'archive',
	tar: 'archive',
	gz: 'archive',
	bz2: 'archive',
	txt: 'text',
	csv: 'text',
	log: 'text',
	md: 'text',
	rtf: 'text',
	js: 'code',
	ts: 'code',
	py: 'code',
	html: 'code',
	css: 'code',
	json: 'code',
	xml: 'code',
	java: 'code',
	go: 'code',
	rs: 'code'
};

/**
 * Returns the icon type category for a given attachment filename.
 *
 * Extracts the file extension (after the last dot), lowercases it, and
 * looks it up in {@link EXT_TO_TYPE}. Returns `'generic'` for unknown
 * or missing extensions.
 *
 * @param filename - The attachment filename (e.g., `"report.pdf"`).
 * @returns The icon type string (e.g., `"pdf"`, `"image"`, `"generic"`).
 */
export function getAttachmentIcon(filename: string): string {
	const dotIdx = filename.lastIndexOf('.');
	if (dotIdx === -1) return 'generic';
	const ext = filename.slice(dotIdx + 1).toLowerCase();
	const type = EXT_TO_TYPE[ext];
	return type ?? 'generic';
}
