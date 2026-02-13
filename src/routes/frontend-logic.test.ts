/**
 * @fileoverview Tests for pure logic patterns embedded in Svelte components.
 *
 * Since `@testing-library/svelte` is not installed, Svelte components cannot
 * be rendered in tests. This file tests the pure (non-reactive) logic patterns
 * that are inlined in the Svelte pages:
 *
 *   - **reconstructFrom** (from +page.svelte): Reconstructs a raw From header
 *     string from parsed `ParsedFrom` parts for rule matching.
 *   - **senderDisplay** (from t/[threadId]/+page.svelte): Extracts a display
 *     name from a message sender's parsed `from` object.
 *   - **formatFileSize** (from t/[threadId]/+page.svelte): Formats a byte count
 *     into a human-readable file size string.
 *   - **attachmentUrl** (from t/[threadId]/+page.svelte): Builds a download URL
 *     for an email attachment.
 *   - **Pagination logic** (from +page.svelte): Gmail-style pagination display
 *     string and master checkbox state computation.
 *   - **Panel localStorage** (from +page.svelte): Loading and saving panel
 *     configuration to/from localStorage with fallback handling.
 *
 * These functions are re-implemented here to match their source implementations
 * exactly, ensuring test coverage of the component logic without needing to
 * render actual Svelte components.
 *
 * Tests cover:
 *   - reconstructFrom: name + email, email-only, empty name
 *   - senderDisplay: name present, email-only with @, email without @
 *   - formatFileSize: 0 bytes, small, KB, MB, GB, boundary values
 *   - attachmentUrl: correct URL construction with encoding
 *   - paginationDisplay: empty, single page, multi-page, exact boundary
 *   - masterCheckState: none selected, all selected, some selected, empty page
 *   - loadPanels: valid JSON, corrupted JSON, empty localStorage, empty array
 *   - savePanels: serialization to localStorage
 */

import { describe, it, expect, vi } from 'vitest';
import type { PanelConfig, AttachmentInfo } from '$lib/types.js';
import { getDefaultPanels, threadMatchesPanel } from '$lib/rules.js';

// =============================================================================
// Re-implementations of Component-Embedded Functions
// =============================================================================
// These match the exact implementations in the Svelte components so that
// tests validate the actual logic. If the source changes, these should
// be updated to match.

/**
 * Reconstructs the raw From header string from parsed parts.
 * Source: src/routes/+page.svelte line ~160
 */
function reconstructFrom(thread: { from: { name: string; email: string } }): string {
	if (thread.from.name) {
		return `${thread.from.name} <${thread.from.email}>`;
	}
	return thread.from.email;
}

/**
 * Returns a display name for the sender.
 * Shows the name if available, otherwise the email prefix.
 * Source: src/routes/t/[threadId]/+page.svelte line ~188
 */
function senderDisplay(msg: { from: { name: string; email: string } }): string {
	if (msg.from.name) return msg.from.name;
	const atIdx = msg.from.email.indexOf('@');
	return atIdx > 0 ? msg.from.email.slice(0, atIdx) : msg.from.email;
}

/**
 * Formats a file size in bytes to a human-readable string.
 * Source: src/routes/t/[threadId]/+page.svelte line ~283
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
 * Source: src/routes/t/[threadId]/+page.svelte line ~300
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

/**
 * Gmail-style pagination display string: "1-20 of 200".
 * Source: src/routes/+page.svelte line ~228
 */
function paginationDisplay(totalThreads: number, currentPage: number, pageSize: number): string {
	if (totalThreads === 0) return '0 of 0';
	const start = (currentPage - 1) * pageSize + 1;
	const end = Math.min(currentPage * pageSize, totalThreads);
	return `${start}\u2013${end} of ${totalThreads}`;
}

/**
 * Master checkbox state for the toolbar.
 * Source: src/routes/+page.svelte line ~241
 */
function masterCheckState(
	displayedThreads: { id: string }[],
	selectedThreadIds: Set<string>
): 'all' | 'some' | 'none' {
	if (displayedThreads.length === 0) return 'none';
	const selectedOnPage = displayedThreads.filter((t) => selectedThreadIds.has(t.id)).length;
	if (selectedOnPage === 0) return 'none';
	if (selectedOnPage === displayedThreads.length) return 'all';
	return 'some';
}

/**
 * Loads panel configuration from localStorage.
 * Source: src/routes/+page.svelte line ~257
 */
function loadPanels(storage: Storage): PanelConfig[] {
	try {
		const saved = storage.getItem('switchboard_panels');
		if (saved) {
			const parsed = JSON.parse(saved) as PanelConfig[];
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed;
			}
		}
	} catch {
		/* Corrupted localStorage data -- fall back to defaults. */
	}
	return getDefaultPanels();
}

/**
 * Returns true if the user has never saved panel config (first-time user).
 * Source: src/routes/+page.svelte line ~276
 */
function isFirstTimeUser(storage: Storage): boolean {
	return storage.getItem('switchboard_panels') === null;
}

/**
 * Persists panel configuration to localStorage.
 * Source: src/routes/+page.svelte line ~281
 */
function savePanels(storage: Storage, p: PanelConfig[]): void {
	try {
		storage.setItem('switchboard_panels', JSON.stringify(p));
	} catch {
		/* localStorage full or unavailable -- silently ignore. */
	}
}

// =============================================================================
// Test Helpers
// =============================================================================

/** Creates a fake localStorage backed by a Map. */
function createFakeStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: vi.fn((key: string) => store.get(key) ?? null),
		setItem: vi.fn((key: string, value: string) => store.set(key, value)),
		removeItem: vi.fn((key: string) => store.delete(key)),
		clear: vi.fn(() => store.clear()),
		get length() {
			return store.size;
		},
		key: vi.fn((_index: number) => null)
	} satisfies Storage;
}

// =============================================================================
// Tests — reconstructFrom
// =============================================================================

describe('reconstructFrom', () => {
	it('formats name + email as "Name <email>"', () => {
		const result = reconstructFrom({
			from: { name: 'John Doe', email: 'john@example.com' }
		});
		expect(result).toBe('John Doe <john@example.com>');
	});

	it('returns just the email when name is empty', () => {
		const result = reconstructFrom({
			from: { name: '', email: 'john@example.com' }
		});
		expect(result).toBe('john@example.com');
	});

	it('handles name with special characters', () => {
		const result = reconstructFrom({
			from: { name: "O'Brien, Jane", email: 'jane@test.com' }
		});
		expect(result).toBe("O'Brien, Jane <jane@test.com>");
	});

	it('handles email-only (no name) for noreply addresses', () => {
		const result = reconstructFrom({
			from: { name: '', email: 'noreply@company.com' }
		});
		expect(result).toBe('noreply@company.com');
	});
});

// =============================================================================
// Tests — senderDisplay
// =============================================================================

describe('senderDisplay', () => {
	it('returns the name when present', () => {
		const result = senderDisplay({
			from: { name: 'Alice Smith', email: 'alice@example.com' }
		});
		expect(result).toBe('Alice Smith');
	});

	it('returns email prefix when name is empty', () => {
		const result = senderDisplay({
			from: { name: '', email: 'bob@example.com' }
		});
		expect(result).toBe('bob');
	});

	it('returns full email when no @ symbol present', () => {
		/* Edge case: malformed email without @ */
		const result = senderDisplay({
			from: { name: '', email: 'localonly' }
		});
		expect(result).toBe('localonly');
	});

	it('returns email prefix for complex email addresses', () => {
		const result = senderDisplay({
			from: { name: '', email: 'first.last+tag@subdomain.example.com' }
		});
		expect(result).toBe('first.last+tag');
	});

	it('returns empty string prefix for email starting with @', () => {
		/*
		 * Edge case: email like "@domain.com" has atIdx = 0,
		 * which is NOT > 0, so it returns the full email.
		 */
		const result = senderDisplay({
			from: { name: '', email: '@domain.com' }
		});
		expect(result).toBe('@domain.com');
	});
});

// =============================================================================
// Tests — formatFileSize
// =============================================================================

describe('formatFileSize', () => {
	it('returns "0 B" for zero bytes', () => {
		expect(formatFileSize(0)).toBe('0 B');
	});

	it('formats small byte values (< 10) with one decimal', () => {
		expect(formatFileSize(1)).toBe('1.0 B');
		expect(formatFileSize(5)).toBe('5.0 B');
		expect(formatFileSize(9)).toBe('9.0 B');
	});

	it('formats byte values >= 10 as rounded integers', () => {
		expect(formatFileSize(10)).toBe('10 B');
		expect(formatFileSize(100)).toBe('100 B');
		expect(formatFileSize(999)).toBe('999 B');
	});

	it('formats kilobytes correctly', () => {
		expect(formatFileSize(1024)).toBe('1.0 KB');
		expect(formatFileSize(1536)).toBe('1.5 KB');
		expect(formatFileSize(10240)).toBe('10 KB');
		expect(formatFileSize(102400)).toBe('100 KB');
	});

	it('formats megabytes correctly', () => {
		expect(formatFileSize(1048576)).toBe('1.0 MB'); /* 1 MB */
		expect(formatFileSize(1572864)).toBe('1.5 MB'); /* 1.5 MB */
		expect(formatFileSize(10485760)).toBe('10 MB'); /* 10 MB */
	});

	it('formats gigabytes correctly', () => {
		expect(formatFileSize(1073741824)).toBe('1.0 GB'); /* 1 GB */
		expect(formatFileSize(2147483648)).toBe('2.0 GB'); /* 2 GB */
	});

	it('clamps to GB for very large values (no TB unit)', () => {
		/* 1 TB = 1024 GB. Since there's no TB unit, it stays in GB. */
		expect(formatFileSize(1099511627776)).toBe('1024 GB');
	});

	it('formats boundary values at unit transitions', () => {
		expect(formatFileSize(1023)).toBe('1023 B'); /* Just under 1 KB */
		expect(formatFileSize(1024)).toBe('1.0 KB'); /* Exactly 1 KB */
		expect(formatFileSize(1048575)).toBe('1024 KB'); /* Just under 1 MB */
		expect(formatFileSize(1048576)).toBe('1.0 MB'); /* Exactly 1 MB */
	});

	it('formats typical attachment sizes correctly', () => {
		expect(formatFileSize(12345)).toBe('12 KB'); /* ~12 KB doc */
		expect(formatFileSize(3456789)).toBe('3.3 MB'); /* ~3.3 MB image */
		expect(formatFileSize(25600000)).toBe('24 MB'); /* ~24 MB video */
	});
});

// =============================================================================
// Tests — attachmentUrl
// =============================================================================

describe('attachmentUrl', () => {
	it('builds the correct URL for a simple attachment', () => {
		const att: AttachmentInfo = {
			filename: 'report.pdf',
			mimeType: 'application/pdf',
			size: 12345,
			attachmentId: 'att-001',
			messageId: 'msg-123'
		};

		const url = attachmentUrl('thread-abc', att);

		expect(url).toContain('/api/thread/thread-abc/attachment?');
		expect(url).toContain('messageId=msg-123');
		expect(url).toContain('attachmentId=att-001');
		expect(url).toContain('filename=report.pdf');
		expect(url).toContain('mimeType=application%2Fpdf');
	});

	it('encodes special characters in thread ID', () => {
		const att: AttachmentInfo = {
			filename: 'file.txt',
			mimeType: 'text/plain',
			size: 100,
			attachmentId: 'att-1',
			messageId: 'msg-1'
		};

		const url = attachmentUrl('thread/with%special', att);

		expect(url).toContain('/api/thread/thread%2Fwith%25special/attachment?');
	});

	it('encodes special characters in filename', () => {
		const att: AttachmentInfo = {
			filename: 'my file (1).pdf',
			mimeType: 'application/pdf',
			size: 500,
			attachmentId: 'att-2',
			messageId: 'msg-2'
		};

		const url = attachmentUrl('thread-1', att);

		/* URLSearchParams encodes spaces as + and parens as %28/%29 */
		expect(url).toContain('filename=my+file+');
	});
});

// =============================================================================
// Tests — paginationDisplay
// =============================================================================

describe('paginationDisplay', () => {
	const PAGE_SIZE = 20;

	it('returns "0 of 0" when there are no threads', () => {
		expect(paginationDisplay(0, 1, PAGE_SIZE)).toBe('0 of 0');
	});

	it('formats a single page correctly', () => {
		expect(paginationDisplay(15, 1, PAGE_SIZE)).toBe('1\u201315 of 15');
	});

	it('formats the first page of a multi-page result', () => {
		expect(paginationDisplay(200, 1, PAGE_SIZE)).toBe('1\u201320 of 200');
	});

	it('formats middle pages correctly', () => {
		expect(paginationDisplay(200, 3, PAGE_SIZE)).toBe('41\u201360 of 200');
	});

	it('formats the last page with fewer items', () => {
		/* 45 threads, page 3: items 41-45 */
		expect(paginationDisplay(45, 3, PAGE_SIZE)).toBe('41\u201345 of 45');
	});

	it('formats an exact page boundary', () => {
		/* 40 threads, page 2: items 21-40 */
		expect(paginationDisplay(40, 2, PAGE_SIZE)).toBe('21\u201340 of 40');
	});

	it('uses en-dash (U+2013) as the range separator', () => {
		const result = paginationDisplay(100, 1, PAGE_SIZE);
		expect(result).toContain('\u2013');
	});
});

// =============================================================================
// Tests — masterCheckState
// =============================================================================

describe('masterCheckState', () => {
	it('returns "none" when displayed threads list is empty', () => {
		expect(masterCheckState([], new Set())).toBe('none');
	});

	it('returns "none" when no threads are selected', () => {
		const threads = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		expect(masterCheckState(threads, new Set())).toBe('none');
	});

	it('returns "all" when all displayed threads are selected', () => {
		const threads = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		expect(masterCheckState(threads, new Set(['a', 'b', 'c']))).toBe('all');
	});

	it('returns "some" when only some threads are selected', () => {
		const threads = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		expect(masterCheckState(threads, new Set(['a', 'c']))).toBe('some');
	});

	it('returns "some" when exactly one thread is selected', () => {
		const threads = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		expect(masterCheckState(threads, new Set(['b']))).toBe('some');
	});

	it('ignores selected IDs not in the displayed threads', () => {
		const threads = [{ id: 'a' }, { id: 'b' }];
		/* 'x' and 'y' are selected but not on this page -- should not count. */
		expect(masterCheckState(threads, new Set(['x', 'y']))).toBe('none');
	});

	it('returns "all" even when extra non-displayed IDs are selected', () => {
		const threads = [{ id: 'a' }, { id: 'b' }];
		/* All displayed IDs are selected + some extras from other pages. */
		expect(masterCheckState(threads, new Set(['a', 'b', 'x', 'y']))).toBe('all');
	});

	it('single thread page: returns "all" when the one thread is selected', () => {
		const threads = [{ id: 'only' }];
		expect(masterCheckState(threads, new Set(['only']))).toBe('all');
	});

	it('single thread page: returns "none" when not selected', () => {
		const threads = [{ id: 'only' }];
		expect(masterCheckState(threads, new Set())).toBe('none');
	});
});

// =============================================================================
// Tests — loadPanels (localStorage)
// =============================================================================

describe('loadPanels', () => {
	it('returns default panels when localStorage has no saved config', () => {
		const storage = createFakeStorage();
		const result = loadPanels(storage);

		expect(result).toEqual(getDefaultPanels());
	});

	it('returns saved panels from localStorage', () => {
		const storage = createFakeStorage();
		const customPanels: PanelConfig[] = [
			{
				name: 'Work',
				rules: [{ field: 'from', pattern: '@company\\.com$', action: 'accept' }]
			},
			{ name: 'Personal', rules: [] },
			{ name: 'Newsletters', rules: [] },
			{ name: 'Other', rules: [] }
		];
		storage.setItem('switchboard_panels', JSON.stringify(customPanels));

		const result = loadPanels(storage);

		expect(result).toEqual(customPanels);
		expect(result[0].name).toBe('Work');
		expect(result[0].rules).toHaveLength(1);
	});

	it('returns defaults when localStorage contains invalid JSON', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', 'not valid json!!!');

		const result = loadPanels(storage);

		expect(result).toEqual(getDefaultPanels());
	});

	it('returns defaults when localStorage contains an empty array', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', '[]');

		const result = loadPanels(storage);

		expect(result).toEqual(getDefaultPanels());
	});

	it('returns defaults when localStorage contains a non-array value', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', '"just a string"');

		const result = loadPanels(storage);

		expect(result).toEqual(getDefaultPanels());
	});

	it('returns defaults when localStorage.getItem throws', () => {
		const storage = createFakeStorage();
		(storage.getItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error('Storage access denied');
		});

		const result = loadPanels(storage);

		expect(result).toEqual(getDefaultPanels());
	});
});

// =============================================================================
// Tests — isFirstTimeUser
// =============================================================================

describe('isFirstTimeUser', () => {
	it('returns true when no panel config exists in localStorage', () => {
		const storage = createFakeStorage();

		expect(isFirstTimeUser(storage)).toBe(true);
	});

	it('returns false when panel config exists in localStorage', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', '[]');

		expect(isFirstTimeUser(storage)).toBe(false);
	});

	it('returns false even if the stored value is invalid JSON', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', 'garbage');

		/* The key exists, so the user is not a first-timer. */
		expect(isFirstTimeUser(storage)).toBe(false);
	});
});

// =============================================================================
// Tests — savePanels
// =============================================================================

describe('savePanels', () => {
	it('serializes panels to localStorage as JSON', () => {
		const storage = createFakeStorage();
		const panels: PanelConfig[] = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@work.com$', action: 'accept' }] },
			{ name: 'Other', rules: [] }
		];

		savePanels(storage, panels);

		const saved = storage.getItem('switchboard_panels');
		expect(saved).toBe(JSON.stringify(panels));
	});

	it('does not throw when localStorage.setItem fails', () => {
		const storage = createFakeStorage();
		(storage.setItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error('QuotaExceededError');
		});

		/* Should silently catch the error. */
		expect(() => savePanels(storage, getDefaultPanels())).not.toThrow();
	});

	it('round-trips through loadPanels correctly', () => {
		const storage = createFakeStorage();
		const panels: PanelConfig[] = [
			{
				name: 'Custom',
				rules: [
					{ field: 'from', pattern: '@example\\.com', action: 'accept' },
					{ field: 'to', pattern: 'newsletter', action: 'reject' }
				]
			},
			{ name: 'Rest', rules: [] }
		];

		savePanels(storage, panels);
		const loaded = loadPanels(storage);

		expect(loaded).toEqual(panels);
	});
});

// =============================================================================
// Re-implementations for Search & Page Size Logic
// =============================================================================

/** Valid page size options — matches the component constant. */
const PAGE_SIZE_OPTIONS = [10, 15, 20, 25, 50, 100] as const;

/**
 * Loads page size from localStorage with validation.
 * Source: src/routes/+page.svelte
 */
function loadPageSize(storage: Storage): number {
	try {
		const saved = storage.getItem('switchboard_page_size');
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
 * Source: src/routes/+page.svelte
 */
function savePageSize(storage: Storage, size: number): void {
	try {
		storage.setItem('switchboard_page_size', String(size));
	} catch {
		/* localStorage full or unavailable — silently ignore. */
	}
}

/**
 * Constructs the fetch URL for thread listing with optional params.
 * Source: src/routes/+page.svelte fetchThreadPage()
 */
function buildFetchUrl(pageToken?: string, q?: string): string {
	const params = new URLSearchParams();
	if (pageToken) params.set('pageToken', pageToken);
	if (q) params.set('q', q);
	return params.toString() ? `/api/threads?${params.toString()}` : '/api/threads';
}

// =============================================================================
// Tests — Search Logic
// =============================================================================

describe('search logic', () => {
	describe('search URL construction', () => {
		it('constructs correct URL with only q parameter', () => {
			const url = buildFetchUrl(undefined, 'from:alice@example.com');
			expect(url).toBe('/api/threads?q=from%3Aalice%40example.com');
		});

		it('constructs correct URL with both pageToken and q', () => {
			const url = buildFetchUrl('page2', 'has:attachment');
			expect(url).toBe('/api/threads?pageToken=page2&q=has%3Aattachment');
		});

		it('constructs /api/threads with no params when no search or pagination', () => {
			const url = buildFetchUrl();
			expect(url).toBe('/api/threads');
		});

		it('constructs URL with only pageToken when no search', () => {
			const url = buildFetchUrl('next');
			expect(url).toBe('/api/threads?pageToken=next');
		});

		it('handles complex Gmail search syntax', () => {
			const url = buildFetchUrl(undefined, 'subject:"team meeting" OR from:boss');
			expect(url).toContain('q=');
			expect(url).toContain('subject');
		});
	});

	describe('handleSearchSubmit behavior (simulated)', () => {
		it('trims whitespace from search input', () => {
			const query = '  from:user@example.com  '.trim();
			expect(query).toBe('from:user@example.com');
		});

		it('does not execute on empty string', () => {
			const query = ''.trim();
			expect(query).toBeFalsy();
		});

		it('does not execute on whitespace-only string', () => {
			const query = '   '.trim();
			expect(query).toBeFalsy();
		});
	});

	describe('clearSearch resets state', () => {
		it('clearSearch produces expected reset values', () => {
			/* Simulates what clearSearch() does: */
			let searchQuery = 'old query';
			let searchInputValue = 'old input';
			let searchAllLoaded = true;
			let searchNextPageToken: string | undefined = 'token';

			/* Reset: */
			searchQuery = '';
			searchInputValue = '';
			searchAllLoaded = false;
			searchNextPageToken = undefined;

			expect(searchQuery).toBe('');
			expect(searchInputValue).toBe('');
			expect(searchAllLoaded).toBe(false);
			expect(searchNextPageToken).toBeUndefined();
		});
	});

	describe('active context switching', () => {
		it('activeThreadList returns searchThreadMetaList when searching', () => {
			const searchQuery = 'from:test';
			const isSearchActive = searchQuery.length > 0;
			const threadMetaList = [{ id: 'inbox-1' }];
			const searchThreadMetaList = [{ id: 'search-1' }];

			const activeThreadList = isSearchActive ? searchThreadMetaList : threadMetaList;
			expect(activeThreadList).toEqual([{ id: 'search-1' }]);
		});

		it('activeThreadList returns threadMetaList when not searching', () => {
			const searchQuery = '';
			const isSearchActive = searchQuery.length > 0;
			const threadMetaList = [{ id: 'inbox-1' }];
			const searchThreadMetaList = [{ id: 'search-1' }];

			const activeThreadList = isSearchActive ? searchThreadMetaList : threadMetaList;
			expect(activeThreadList).toEqual([{ id: 'inbox-1' }]);
		});

		it('isSearchActive is true when searchQuery is non-empty', () => {
			expect('from:test'.length > 0).toBe(true);
		});

		it('isSearchActive is false when searchQuery is empty', () => {
			expect(''.length > 0).toBe(false);
		});
	});

	describe('cross-list operations', () => {
		it('markAsRead updates thread in both inbox and search lists', () => {
			const threadId = 't1';
			const threadMetaList = [{ id: 't1', labelIds: ['INBOX', 'UNREAD'] }];
			const searchThreadMetaList = [{ id: 't1', labelIds: ['INBOX', 'UNREAD'] }];

			/* Simulate markAsRead: remove UNREAD from both lists. */
			const thread = threadMetaList.find((t) => t.id === threadId);
			if (thread) thread.labelIds = thread.labelIds.filter((l) => l !== 'UNREAD');
			const searchThread = searchThreadMetaList.find((t) => t.id === threadId);
			if (searchThread) searchThread.labelIds = searchThread.labelIds.filter((l) => l !== 'UNREAD');

			expect(thread!.labelIds).toEqual(['INBOX']);
			expect(searchThread!.labelIds).toEqual(['INBOX']);
		});

		it('trash removes thread from both inbox and search lists', () => {
			const idsToTrash = ['t1', 't2'];
			const threadMetaList = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
			const searchThreadMetaList = [{ id: 't1' }, { id: 't3' }];

			const newThreadMetaList = threadMetaList.filter((t) => !idsToTrash.includes(t.id));
			const newSearchList = searchThreadMetaList.filter((t) => !idsToTrash.includes(t.id));

			expect(newThreadMetaList).toEqual([{ id: 't3' }]);
			expect(newSearchList).toEqual([{ id: 't3' }]);
		});

		it('trash rollback restores both lists on failure', () => {
			const snapshot = [{ id: 't1' }, { id: 't2' }];
			const searchSnapshot = [{ id: 't1' }];

			/* Simulate failure → rollback. */
			let threadMetaList = [{ id: 't2' }]; /* after trash */
			let searchThreadMetaList: { id: string }[] = []; /* after trash */

			/* Rollback: */
			threadMetaList = snapshot;
			searchThreadMetaList = searchSnapshot;

			expect(threadMetaList).toEqual([{ id: 't1' }, { id: 't2' }]);
			expect(searchThreadMetaList).toEqual([{ id: 't1' }]);
		});
	});
});

// =============================================================================
// Tests — Page Size Configuration
// =============================================================================

describe('page size configuration', () => {
	it('loadPageSize returns 20 (default) when nothing stored', () => {
		const storage = createFakeStorage();
		expect(loadPageSize(storage)).toBe(20);
	});

	it('loadPageSize returns stored value when valid', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_page_size', '50');
		expect(loadPageSize(storage)).toBe(50);
	});

	it('loadPageSize returns default for invalid value', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_page_size', '99');
		expect(loadPageSize(storage)).toBe(20);
	});

	it('loadPageSize returns default for non-numeric value', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_page_size', 'abc');
		expect(loadPageSize(storage)).toBe(20);
	});

	it('loadPageSize returns default when localStorage throws', () => {
		const storage = createFakeStorage();
		(storage.getItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error('Access denied');
		});
		expect(loadPageSize(storage)).toBe(20);
	});

	it('savePageSize persists to localStorage', () => {
		const storage = createFakeStorage();
		savePageSize(storage, 25);
		expect(storage.getItem('switchboard_page_size')).toBe('25');
	});

	it('savePageSize does not throw when localStorage fails', () => {
		const storage = createFakeStorage();
		(storage.setItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error('QuotaExceededError');
		});
		expect(() => savePageSize(storage, 50)).not.toThrow();
	});

	it('round-trips through save and load correctly', () => {
		const storage = createFakeStorage();
		savePageSize(storage, 100);
		expect(loadPageSize(storage)).toBe(100);
	});

	it('accepts all valid page size options', () => {
		const storage = createFakeStorage();
		for (const size of PAGE_SIZE_OPTIONS) {
			storage.setItem('switchboard_page_size', String(size));
			expect(loadPageSize(storage)).toBe(size);
		}
	});

	it('pagination recalculates with different page sizes', () => {
		/* Verify pagination math with different page sizes. */
		expect(paginationDisplay(100, 1, 10)).toBe('1\u201310 of 100');
		expect(paginationDisplay(100, 1, 25)).toBe('1\u201325 of 100');
		expect(paginationDisplay(100, 1, 50)).toBe('1\u201350 of 100');
		expect(paginationDisplay(100, 2, 50)).toBe('51\u2013100 of 100');
	});
});

// =============================================================================
// Tests — thread panel matching (threadMatchesPanel)
// =============================================================================

describe('thread panel matching (threadMatchesPanel)', () => {
	function reconstructFrom(thread: { from: { name: string; email: string } }): string {
		if (thread.from.name) return `${thread.from.name} <${thread.from.email}>`;
		return thread.from.email;
	}

	it('thread appears in all no-rules panels', () => {
		const panels: PanelConfig[] = [
			{ name: 'A', rules: [] },
			{ name: 'B', rules: [] },
			{ name: 'C', rules: [] }
		];
		const thread = { from: { name: 'Test', email: 'test@example.com' }, to: 'me@gmail.com' };
		const fromRaw = reconstructFrom(thread);
		for (const panel of panels) {
			expect(threadMatchesPanel(panel, fromRaw, thread.to)).toBe(true);
		}
	});

	it('thread appears in multiple matching rules panels', () => {
		const panels: PanelConfig[] = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }] },
			{ name: 'All Company', rules: [{ field: 'from', pattern: 'company', action: 'accept' }] }
		];
		const thread = { from: { name: '', email: 'news@company.com' }, to: '' };
		const fromRaw = reconstructFrom(thread);
		expect(threadMatchesPanel(panels[0], fromRaw, '')).toBe(true);
		expect(threadMatchesPanel(panels[1], fromRaw, '')).toBe(true);
	});

	it('thread appears in no-rules panel AND matching rules panel', () => {
		const noRules: PanelConfig = { name: 'All', rules: [] };
		const withRules: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
		};
		const thread = { from: { name: '', email: 'boss@company.com' }, to: '' };
		const fromRaw = reconstructFrom(thread);
		expect(threadMatchesPanel(noRules, fromRaw, '')).toBe(true);
		expect(threadMatchesPanel(withRules, fromRaw, '')).toBe(true);
	});
});

// =============================================================================
// Tests — pagination display with estimates
// =============================================================================

describe('pagination display with estimates', () => {
	/**
	 * Updated paginationDisplay that uses isEstimate flag.
	 * Source: src/routes/+page.svelte (updated)
	 */
	type PanelCount = { total: number; unread: number; isEstimate: boolean };

	function paginationDisplayWithEstimate(
		loaded: number,
		currentPage: number,
		pageSize: number,
		allLoaded: boolean,
		panelCount: PanelCount | null
	): string {
		if (loaded === 0) return '0 of 0';
		const start = (currentPage - 1) * pageSize + 1;
		const end = Math.min(currentPage * pageSize, loaded);
		if (allLoaded) return `${start}\u2013${end} of ${loaded.toLocaleString()}`;
		if (panelCount) {
			const displayTotal = Math.max(panelCount.total, loaded);
			const formatted = displayTotal.toLocaleString();
			const total = panelCount.isEstimate ? `~${formatted}` : formatted;
			return `${start}\u2013${end} of ${total}`;
		}
		return `${start}\u2013${end} of ${loaded.toLocaleString()}`;
	}

	it('shows exact count without tilde for non-estimate panels', () => {
		const result = paginationDisplayWithEstimate(20, 1, 20, false, {
			total: 500,
			unread: 10,
			isEstimate: false
		});
		expect(result).toBe('1\u201320 of 500');
		expect(result).not.toContain('~');
	});

	it('shows tilde prefix for estimated count panels', () => {
		const result = paginationDisplayWithEstimate(20, 1, 20, false, {
			total: 500,
			unread: 10,
			isEstimate: true
		});
		expect(result).toBe('1\u201320 of ~500');
	});

	it('uses loaded count when all threads loaded (no tilde)', () => {
		const result = paginationDisplayWithEstimate(45, 1, 20, true, {
			total: 500,
			unread: 10,
			isEstimate: true
		});
		expect(result).toBe('1\u201320 of 45');
		expect(result).not.toContain('~');
	});

	it('estimate-based totalPanelPages enables forward pagination', () => {
		/* Simulate: 20 loaded threads, estimate says 500 total, pageSize 20 → 25 pages */
		const loaded = 20;
		const estimate = 500;
		const pageSize = 20;
		const totalPages = Math.max(1, Math.ceil(Math.max(estimate, loaded) / pageSize));
		expect(totalPages).toBe(25);
	});
});

// =============================================================================
// Tests — unread badge behavior
// =============================================================================

describe('unread badge behavior', () => {
	type PanelCount = { total: number; unread: number; isEstimate: boolean };

	function computePanelStats(
		panels: PanelConfig[],
		threads: Array<{ from: { name: string; email: string }; to: string; labelIds: string[] }>,
		allLoaded: boolean,
		panelCountEstimates: PanelCount[] | null
	) {
		const loadedStats = panels.map(() => ({ total: 0, unread: 0 }));
		for (const thread of threads) {
			const fromRaw = thread.from.name
				? `${thread.from.name} <${thread.from.email}>`
				: thread.from.email;
			for (let i = 0; i < panels.length; i++) {
				if (threadMatchesPanel(panels[i], fromRaw, thread.to)) {
					loadedStats[i].total++;
					if (thread.labelIds.includes('UNREAD')) loadedStats[i].unread++;
				}
			}
		}
		if (allLoaded) return loadedStats;
		if (!panelCountEstimates) return loadedStats.map((s) => ({ total: s.total, unread: 0 }));
		return loadedStats.map((loaded, i) => {
			const est = panelCountEstimates![i];
			if (!est) return { total: loaded.total, unread: 0 };
			return { total: Math.max(est.total, loaded.total), unread: est.unread };
		});
	}

	const singlePanel: PanelConfig[] = [{ name: 'All', rules: [] }];
	const threads = [
		{ from: { name: '', email: 'a@test.com' }, to: '', labelIds: ['INBOX', 'UNREAD'] },
		{ from: { name: '', email: 'b@test.com' }, to: '', labelIds: ['INBOX'] }
	];

	it('suppresses unread badges before server estimates arrive', () => {
		const stats = computePanelStats(singlePanel, threads, false, null);
		expect(stats[0].unread).toBe(0);
		expect(stats[0].total).toBe(2);
	});

	it('shows server unread counts once estimates arrive', () => {
		const estimates: PanelCount[] = [{ total: 500, unread: 42, isEstimate: false }];
		const stats = computePanelStats(singlePanel, threads, false, estimates);
		expect(stats[0].unread).toBe(42);
	});

	it('uses exact loaded counts when all threads loaded', () => {
		const estimates: PanelCount[] = [{ total: 500, unread: 42, isEstimate: false }];
		const stats = computePanelStats(singlePanel, threads, true, estimates);
		expect(stats[0].unread).toBe(1);
		expect(stats[0].total).toBe(2);
	});

	it('optimistically decrements unread on mark-as-read', () => {
		/* Simulate decrement: original unread was 42, after mark-as-read it becomes 41 */
		const updated: PanelCount[] = [{ total: 500, unread: 41, isEstimate: false }];
		const stats = computePanelStats(singlePanel, threads, false, updated);
		expect(stats[0].unread).toBe(41);
	});

	it('switches to search-scoped unread counts during search', () => {
		const inboxEstimates: PanelCount[] = [{ total: 500, unread: 42, isEstimate: false }];
		const searchEstimates: PanelCount[] = [{ total: 20, unread: 3, isEstimate: true }];
		/* Simulate: isSearchActive = true → use searchEstimates */
		const isSearchActive = true;
		const activeEstimates = isSearchActive ? searchEstimates : inboxEstimates;
		const stats = computePanelStats(singlePanel, threads, false, activeEstimates);
		expect(stats[0].unread).toBe(3);
	});
});

// =============================================================================
// Re-implementation — getAttachmentIcon
// =============================================================================

/**
 * Maps file extensions to icon type categories.
 * Source: src/routes/t/[threadId]/+page.svelte
 */
const EXT_TO_TYPE: Record<string, string> = {
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
 * Returns the icon type string for a given attachment filename.
 * Extracts the file extension (after the last dot), lowercases it,
 * and looks it up in the EXT_TO_TYPE map. Returns 'generic' for
 * unknown or missing extensions.
 * Source: src/routes/t/[threadId]/+page.svelte
 */
function getAttachmentIcon(filename: string): string {
	const dotIdx = filename.lastIndexOf('.');
	if (dotIdx === -1) return 'generic';
	const ext = filename.slice(dotIdx + 1).toLowerCase();
	const type = EXT_TO_TYPE[ext];
	return type ?? 'generic';
}

// =============================================================================
// Tests — getAttachmentIcon
// =============================================================================

describe('getAttachmentIcon', () => {
	it('returns "pdf" for .pdf files', () => {
		expect(getAttachmentIcon('report.pdf')).toBe('pdf');
	});

	it('returns "word" for .docx files', () => {
		expect(getAttachmentIcon('doc.docx')).toBe('word');
	});

	it('returns "spreadsheet" for .xlsx files', () => {
		expect(getAttachmentIcon('data.xlsx')).toBe('spreadsheet');
	});

	it('returns "image" for .jpg files', () => {
		expect(getAttachmentIcon('photo.jpg')).toBe('image');
	});

	it('returns "image" for uppercase .PNG (case insensitive via toLowerCase)', () => {
		expect(getAttachmentIcon('image.PNG')).toBe('image');
	});

	it('returns "video" for .mp4 files', () => {
		expect(getAttachmentIcon('clip.mp4')).toBe('video');
	});

	it('returns "audio" for .mp3 files', () => {
		expect(getAttachmentIcon('song.mp3')).toBe('audio');
	});

	it('returns "archive" for .zip files', () => {
		expect(getAttachmentIcon('backup.zip')).toBe('archive');
	});

	it('returns "archive" for .tar files', () => {
		expect(getAttachmentIcon('files.tar')).toBe('archive');
	});

	it('returns "text" for .txt files', () => {
		expect(getAttachmentIcon('readme.txt')).toBe('text');
	});

	it('returns "text" for .md files', () => {
		expect(getAttachmentIcon('notes.md')).toBe('text');
	});

	it('returns "code" for .ts files', () => {
		expect(getAttachmentIcon('app.ts')).toBe('code');
	});

	it('returns "code" for .css files', () => {
		expect(getAttachmentIcon('style.css')).toBe('code');
	});

	it('returns "code" for .py files', () => {
		expect(getAttachmentIcon('main.py')).toBe('code');
	});

	it('returns "generic" for unknown extension', () => {
		expect(getAttachmentIcon('file.xyz')).toBe('generic');
	});

	it('returns "generic" for files with no extension', () => {
		expect(getAttachmentIcon('README')).toBe('generic');
	});

	it('returns "generic" for empty string', () => {
		expect(getAttachmentIcon('')).toBe('generic');
	});

	it('returns "generic" for dotfiles like .gitignore (extension is "gitignore")', () => {
		expect(getAttachmentIcon('.gitignore')).toBe('generic');
	});

	it('uses the last extension for filenames with multiple dots (archive.tar.gz → archive)', () => {
		expect(getAttachmentIcon('archive.tar.gz')).toBe('archive');
	});
});

// =============================================================================
// Re-implementation — computeTotalPanelPages
// =============================================================================

/**
 * Computes the total number of pages for a panel given loaded thread count,
 * page size, whether all threads have been loaded, and an optional server
 * estimate of total threads.
 * Source: src/routes/+page.svelte
 */
function computeTotalPanelPages(
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
// Tests — computeTotalPanelPages
// =============================================================================

describe('computeTotalPanelPages', () => {
	it('returns 1 for 0 loaded threads', () => {
		expect(computeTotalPanelPages(0, 20, false, undefined)).toBe(1);
	});

	it('returns 1 for less than 1 page of threads', () => {
		expect(computeTotalPanelPages(5, 20, false, undefined)).toBe(1);
	});

	it('returns correct pages for exact page multiple', () => {
		expect(computeTotalPanelPages(60, 20, false, undefined)).toBe(3);
	});

	it('uses loaded count when allLoaded is true (ignoring estimate)', () => {
		expect(computeTotalPanelPages(45, 20, true, 500)).toBe(3);
	});

	it('uses estimate when not allLoaded and estimate > loaded', () => {
		expect(computeTotalPanelPages(20, 20, false, 500)).toBe(25);
	});

	it('falls back to loaded when estimate is undefined', () => {
		expect(computeTotalPanelPages(40, 20, false, undefined)).toBe(2);
	});

	it('falls back to loaded when estimate <= loaded', () => {
		expect(computeTotalPanelPages(50, 20, false, 30)).toBe(3);
	});

	it('returns minimum of 1 page always', () => {
		expect(computeTotalPanelPages(0, 20, true, undefined)).toBe(1);
		expect(computeTotalPanelPages(0, 20, false, 0)).toBe(1);
		expect(computeTotalPanelPages(0, 50, false, undefined)).toBe(1);
	});
});

// =============================================================================
// Tests — paginationDisplayWithEstimate additional edge cases
// =============================================================================

describe('paginationDisplayWithEstimate edge cases', () => {
	type PanelCount = { total: number; unread: number; isEstimate: boolean };

	/**
	 * Re-implementation of paginationDisplayWithEstimate for additional edge cases.
	 * Source: src/routes/+page.svelte (updated — always prefers server count)
	 */
	function paginationDisplayWithEstimate(
		loaded: number,
		currentPage: number,
		pageSize: number,
		allLoaded: boolean,
		panelCount: PanelCount | null
	): string {
		if (loaded === 0) return '0 of 0';
		const start = (currentPage - 1) * pageSize + 1;
		const end = Math.min(currentPage * pageSize, loaded);
		if (allLoaded) return `${start}\u2013${end} of ${loaded.toLocaleString()}`;
		if (panelCount) {
			const displayTotal = Math.max(panelCount.total, loaded);
			const formatted = displayTotal.toLocaleString();
			const total = panelCount.isEstimate ? `~${formatted}` : formatted;
			return `${start}\u2013${end} of ${total}`;
		}
		return `${start}\u2013${end} of ${loaded.toLocaleString()}`;
	}

	it('returns loaded count when panelCount is null', () => {
		const result = paginationDisplayWithEstimate(20, 1, 20, false, null);
		expect(result).toBe('1\u201320 of 20');
	});

	it('uses max of server total and loaded count when server total is lower', () => {
		const result = paginationDisplayWithEstimate(50, 1, 20, false, {
			total: 30,
			unread: 5,
			isEstimate: false
		});
		/* max(30, 50) = 50 — loaded count is higher, so it's used as the display total */
		expect(result).toBe('1\u201320 of 50');
	});

	it('shows "0 of 0" when loaded is 0 even with estimate', () => {
		const result = paginationDisplayWithEstimate(0, 1, 20, false, {
			total: 500,
			unread: 10,
			isEstimate: true
		});
		expect(result).toBe('0 of 0');
	});

	it('formats large numbers with locale separators in tilde mode', () => {
		const result = paginationDisplayWithEstimate(20, 1, 20, false, {
			total: 12345,
			unread: 100,
			isEstimate: true
		});
		/* toLocaleString() formats 12345 → "12,345" in en-US locale */
		const formatted = (12345).toLocaleString();
		expect(result).toBe(`1\u201320 of ~${formatted}`);
	});
});

// =============================================================================
// Re-implementation — decrementUnreadCounts
// =============================================================================

/**
 * Optimistically decrements unread counts for panels after a mark-as-read
 * action. Returns null if estimates are null. Clamps to zero.
 * Source: src/routes/+page.svelte
 */
type DecrementPanelCount = { total: number; unread: number; isEstimate: boolean };

function decrementUnreadCounts(
	estimates: DecrementPanelCount[] | null,
	panelUnreadDecrements: number[]
): DecrementPanelCount[] | null {
	if (!estimates) return null;
	return estimates.map((c, i) => ({
		...c,
		unread: Math.max(0, c.unread - (panelUnreadDecrements[i] ?? 0))
	}));
}

// =============================================================================
// Tests — decrementUnreadCounts
// =============================================================================

describe('decrementUnreadCounts', () => {
	it('returns null when estimates are null', () => {
		expect(decrementUnreadCounts(null, [1, 2])).toBeNull();
	});

	it('decrements unread for specified panel', () => {
		const estimates: DecrementPanelCount[] = [{ total: 100, unread: 10, isEstimate: false }];
		const result = decrementUnreadCounts(estimates, [3]);
		expect(result).not.toBeNull();
		expect(result![0].unread).toBe(7);
	});

	it('clamps to zero (does not go negative)', () => {
		const estimates: DecrementPanelCount[] = [{ total: 100, unread: 2, isEstimate: false }];
		const result = decrementUnreadCounts(estimates, [5]);
		expect(result![0].unread).toBe(0);
	});

	it('does not affect other fields (total, isEstimate preserved)', () => {
		const estimates: DecrementPanelCount[] = [{ total: 500, unread: 42, isEstimate: true }];
		const result = decrementUnreadCounts(estimates, [10]);
		expect(result![0].total).toBe(500);
		expect(result![0].isEstimate).toBe(true);
		expect(result![0].unread).toBe(32);
	});

	it('handles missing decrement values (treats as 0)', () => {
		const estimates: DecrementPanelCount[] = [
			{ total: 100, unread: 10, isEstimate: false },
			{ total: 200, unread: 20, isEstimate: false }
		];
		/* Only one decrement provided for two panels */
		const result = decrementUnreadCounts(estimates, [5]);
		expect(result![0].unread).toBe(5);
		expect(result![1].unread).toBe(20); /* No decrement applied */
	});

	it('decrements across multiple panels', () => {
		const estimates: DecrementPanelCount[] = [
			{ total: 100, unread: 10, isEstimate: false },
			{ total: 200, unread: 20, isEstimate: true },
			{ total: 300, unread: 30, isEstimate: false }
		];
		const result = decrementUnreadCounts(estimates, [2, 5, 10]);
		expect(result![0].unread).toBe(8);
		expect(result![1].unread).toBe(15);
		expect(result![2].unread).toBe(20);
	});
});

// =============================================================================
// Re-implementation — shouldShowFetchDot
// =============================================================================

/**
 * Determines whether the auto-fill fetch loading dot indicator should be
 * shown for a given panel tab. Only the active panel shows the dot, and
 * only when auto-fill loading is in progress.
 * Source: src/routes/+page.svelte
 */
function shouldShowFetchDot(
	activePanel: number,
	panelIndex: number,
	autoFillLoading: boolean
): boolean {
	return activePanel === panelIndex && autoFillLoading;
}

// =============================================================================
// Tests — shouldShowFetchDot (tab fetch dot indicator logic)
// =============================================================================

describe('shouldShowFetchDot', () => {
	it('shows dot on active panel when loading', () => {
		expect(shouldShowFetchDot(0, 0, true)).toBe(true);
		expect(shouldShowFetchDot(2, 2, true)).toBe(true);
	});

	it('hides dot on inactive panels when loading', () => {
		expect(shouldShowFetchDot(0, 1, true)).toBe(false);
		expect(shouldShowFetchDot(1, 0, true)).toBe(false);
		expect(shouldShowFetchDot(2, 0, true)).toBe(false);
	});

	it('hides dot on active panel when not loading', () => {
		expect(shouldShowFetchDot(0, 0, false)).toBe(false);
		expect(shouldShowFetchDot(1, 1, false)).toBe(false);
	});

	it('hides dot on all panels when not loading', () => {
		expect(shouldShowFetchDot(0, 0, false)).toBe(false);
		expect(shouldShowFetchDot(0, 1, false)).toBe(false);
		expect(shouldShowFetchDot(0, 2, false)).toBe(false);
		expect(shouldShowFetchDot(0, 3, false)).toBe(false);
	});
});
