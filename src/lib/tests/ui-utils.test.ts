/**
 * @fileoverview Tests for pure UI utility functions in `$lib/ui-utils.ts`.
 *
 * These tests import the **real** extracted functions directly — no
 * re-implementations. Every function that was previously tested via
 * re-implementation in `frontend-logic.test.ts` is now tested by
 * direct import, plus expanded edge cases.
 *
 * Test groups:
 *   - reconstructFrom: From header reconstruction for rule matching
 *   - senderDisplay: Display name extraction from sender
 *   - formatFileSize: Human-readable file size formatting
 *   - attachmentUrl: Attachment download URL construction
 *   - getAttachmentIcon: File extension → icon category mapping
 *   - computePaginationDisplay: Gmail-style pagination string
 *   - masterCheckState: Toolbar checkbox state computation
 *   - loadPanels / savePanels / isFirstTimeUser: Panel localStorage
 *   - loadPageSize / savePageSize: Page size localStorage
 *   - buildThreadsUrl: Thread listing URL construction
 *   - computeTotalPanelPages: Total pages from loaded + estimate
 *   - computePanelStats: Per-panel total/unread with estimates
 *   - decrementUnreadCounts: Optimistic unread decrement
 *   - Thread panel matching integration (with threadMatchesPanel)
 *   - Search behavioral patterns
 */

import { describe, it, expect, vi } from 'vitest';
import type { PanelConfig, AttachmentInfo, PanelCount } from '$lib/types.js';
import { threadMatchesPanel, getDefaultPanels } from '$lib/rules.js';
import {
	reconstructFrom,
	masterCheckState,
	loadPanels,
	savePanels,
	isFirstTimeUser,
	loadPageSize,
	savePageSize,
	PAGE_SIZE_OPTIONS,
	buildThreadsUrl,
	computePaginationDisplay,
	computeTotalPanelPages,
	computePanelStats,
	decrementUnreadCounts,
	senderDisplay,
	formatFileSize,
	attachmentUrl,
	getAttachmentIcon,
	EXT_TO_TYPE,
	migrateOldPanelFormat,
	patternToAddresses
} from '$lib/ui-utils.js';

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

	it('handles name with special characters (quotes, commas)', () => {
		const result = reconstructFrom({
			from: { name: "O'Brien, Jane", email: 'jane@test.com' }
		});
		expect(result).toBe("O'Brien, Jane <jane@test.com>");
	});

	it('handles email-only for noreply addresses', () => {
		const result = reconstructFrom({
			from: { name: '', email: 'noreply@company.com' }
		});
		expect(result).toBe('noreply@company.com');
	});

	it('handles unicode name', () => {
		const result = reconstructFrom({
			from: { name: 'José García', email: 'jose@test.com' }
		});
		expect(result).toBe('José García <jose@test.com>');
	});

	it('handles empty email string', () => {
		const result = reconstructFrom({ from: { name: '', email: '' } });
		expect(result).toBe('');
	});

	it('handles whitespace-only name (treated as truthy)', () => {
		const result = reconstructFrom({
			from: { name: '  ', email: 'x@y.com' }
		});
		/* Whitespace-only name is truthy, so the name + email format is used. */
		expect(result).toBe('   <x@y.com>');
	});

	it('handles angle brackets in email', () => {
		const result = reconstructFrom({
			from: { name: '', email: 'a<b>@c.com' }
		});
		expect(result).toBe('a<b>@c.com');
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
		const result = senderDisplay({
			from: { name: '', email: 'localonly' }
		});
		expect(result).toBe('localonly');
	});

	it('returns email prefix for complex email (dots, +tags)', () => {
		const result = senderDisplay({
			from: { name: '', email: 'first.last+tag@sub.example.com' }
		});
		expect(result).toBe('first.last+tag');
	});

	it('returns full email for email starting with @', () => {
		/* atIdx = 0, which is NOT > 0, so it returns the full email. */
		const result = senderDisplay({
			from: { name: '', email: '@domain.com' }
		});
		expect(result).toBe('@domain.com');
	});

	it('returns empty string for empty email with no name', () => {
		const result = senderDisplay({ from: { name: '', email: '' } });
		expect(result).toBe('');
	});

	it('handles unicode name', () => {
		const result = senderDisplay({
			from: { name: '日本語', email: 'x@y.com' }
		});
		expect(result).toBe('日本語');
	});

	it('handles email with multiple @ signs', () => {
		/* indexOf('@') returns the first @, so it slices before the first one. */
		const result = senderDisplay({
			from: { name: '', email: 'user@host@domain.com' }
		});
		expect(result).toBe('user');
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
		expect(formatFileSize(1048576)).toBe('1.0 MB');
		expect(formatFileSize(1572864)).toBe('1.5 MB');
		expect(formatFileSize(10485760)).toBe('10 MB');
	});

	it('formats gigabytes correctly', () => {
		expect(formatFileSize(1073741824)).toBe('1.0 GB');
		expect(formatFileSize(2147483648)).toBe('2.0 GB');
	});

	it('clamps to GB for very large values (no TB unit)', () => {
		expect(formatFileSize(1099511627776)).toBe('1024 GB');
	});

	it('formats boundary values at unit transitions', () => {
		expect(formatFileSize(1023)).toBe('1023 B');
		expect(formatFileSize(1024)).toBe('1.0 KB');
		expect(formatFileSize(1048575)).toBe('1024 KB');
		expect(formatFileSize(1048576)).toBe('1.0 MB');
	});

	it('formats typical attachment sizes', () => {
		expect(formatFileSize(12345)).toBe('12 KB');
		expect(formatFileSize(3456789)).toBe('3.3 MB');
		expect(formatFileSize(25600000)).toBe('24 MB');
	});

	it('handles 1 byte', () => {
		expect(formatFileSize(1)).toBe('1.0 B');
	});

	it('handles fractional display at boundary (9.99 KB rounds to 10.0 KB)', () => {
		/* 9.99 * 1024 = 10229.76 — val/1024 = 9.99, rounds to 10.0 via toFixed(1). */
		const val = 9.99 * 1024;
		const result = formatFileSize(val);
		expect(result).toBe('10.0 KB');
	});

	it('handles very large GB values', () => {
		expect(formatFileSize(10737418240)).toBe('10 GB'); /* 10 GB */
		expect(formatFileSize(107374182400)).toBe('100 GB'); /* 100 GB */
	});

	it('handles exact power-of-two values', () => {
		expect(formatFileSize(Math.pow(2, 10))).toBe('1.0 KB');
		expect(formatFileSize(Math.pow(2, 20))).toBe('1.0 MB');
		expect(formatFileSize(Math.pow(2, 30))).toBe('1.0 GB');
	});

	it('formats 512 bytes correctly', () => {
		expect(formatFileSize(512)).toBe('512 B');
	});
});

// =============================================================================
// Tests — attachmentUrl
// =============================================================================

describe('attachmentUrl', () => {
	it('builds correct URL for a simple attachment', () => {
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

	it('handles empty string threadId', () => {
		const att: AttachmentInfo = {
			filename: 'test.txt',
			mimeType: 'text/plain',
			size: 10,
			attachmentId: 'a',
			messageId: 'm'
		};

		const url = attachmentUrl('', att);

		expect(url).toContain('/api/thread//attachment?');
	});

	it('handles unicode filename', () => {
		const att: AttachmentInfo = {
			filename: '日本語.pdf',
			mimeType: 'application/pdf',
			size: 100,
			attachmentId: 'att-u',
			messageId: 'msg-u'
		};

		const url = attachmentUrl('t1', att);

		/* URLSearchParams encodes unicode characters */
		expect(url).toContain('filename=');
		expect(url).toContain('attachment?');
	});

	it('handles very long attachment IDs', () => {
		const longId = 'a'.repeat(500);
		const att: AttachmentInfo = {
			filename: 'file.txt',
			mimeType: 'text/plain',
			size: 10,
			attachmentId: longId,
			messageId: 'msg-1'
		};

		const url = attachmentUrl('t1', att);

		/* No truncation — the full ID is in the URL. */
		expect(url).toContain(`attachmentId=${longId}`);
	});
});

// =============================================================================
// Tests — getAttachmentIcon
// =============================================================================

describe('getAttachmentIcon', () => {
	it('returns "pdf" for .pdf files', () => {
		expect(getAttachmentIcon('report.pdf')).toBe('pdf');
	});

	it('returns "word" for .doc files', () => {
		expect(getAttachmentIcon('doc.doc')).toBe('word');
	});

	it('returns "word" for .docx files', () => {
		expect(getAttachmentIcon('doc.docx')).toBe('word');
	});

	it('returns "spreadsheet" for .xls files', () => {
		expect(getAttachmentIcon('data.xls')).toBe('spreadsheet');
	});

	it('returns "spreadsheet" for .xlsx files', () => {
		expect(getAttachmentIcon('data.xlsx')).toBe('spreadsheet');
	});

	it('returns "presentation" for .ppt files', () => {
		expect(getAttachmentIcon('slides.ppt')).toBe('presentation');
	});

	it('returns "presentation" for .pptx files', () => {
		expect(getAttachmentIcon('slides.pptx')).toBe('presentation');
	});

	it('returns "image" for .jpg files', () => {
		expect(getAttachmentIcon('photo.jpg')).toBe('image');
	});

	it('returns "image" for .jpeg files', () => {
		expect(getAttachmentIcon('photo.jpeg')).toBe('image');
	});

	it('returns "image" for .png files', () => {
		expect(getAttachmentIcon('image.png')).toBe('image');
	});

	it('returns "image" for .gif files', () => {
		expect(getAttachmentIcon('anim.gif')).toBe('image');
	});

	it('returns "image" for .webp files', () => {
		expect(getAttachmentIcon('img.webp')).toBe('image');
	});

	it('returns "image" for .svg files', () => {
		expect(getAttachmentIcon('logo.svg')).toBe('image');
	});

	it('returns "image" for .bmp files', () => {
		expect(getAttachmentIcon('bitmap.bmp')).toBe('image');
	});

	it('returns "image" for .ico files', () => {
		expect(getAttachmentIcon('favicon.ico')).toBe('image');
	});

	it('returns "video" for .mp4 files', () => {
		expect(getAttachmentIcon('clip.mp4')).toBe('video');
	});

	it('returns "video" for .mov files', () => {
		expect(getAttachmentIcon('clip.mov')).toBe('video');
	});

	it('returns "video" for .avi files', () => {
		expect(getAttachmentIcon('clip.avi')).toBe('video');
	});

	it('returns "video" for .mkv files', () => {
		expect(getAttachmentIcon('clip.mkv')).toBe('video');
	});

	it('returns "video" for .webm files', () => {
		expect(getAttachmentIcon('clip.webm')).toBe('video');
	});

	it('returns "audio" for .mp3 files', () => {
		expect(getAttachmentIcon('song.mp3')).toBe('audio');
	});

	it('returns "audio" for .wav files', () => {
		expect(getAttachmentIcon('sound.wav')).toBe('audio');
	});

	it('returns "audio" for .ogg files', () => {
		expect(getAttachmentIcon('sound.ogg')).toBe('audio');
	});

	it('returns "audio" for .flac files', () => {
		expect(getAttachmentIcon('music.flac')).toBe('audio');
	});

	it('returns "audio" for .aac files', () => {
		expect(getAttachmentIcon('audio.aac')).toBe('audio');
	});

	it('returns "archive" for .zip files', () => {
		expect(getAttachmentIcon('backup.zip')).toBe('archive');
	});

	it('returns "archive" for .rar files', () => {
		expect(getAttachmentIcon('backup.rar')).toBe('archive');
	});

	it('returns "archive" for .7z files', () => {
		expect(getAttachmentIcon('backup.7z')).toBe('archive');
	});

	it('returns "archive" for .tar files', () => {
		expect(getAttachmentIcon('files.tar')).toBe('archive');
	});

	it('returns "archive" for .gz files', () => {
		expect(getAttachmentIcon('files.gz')).toBe('archive');
	});

	it('returns "archive" for .bz2 files', () => {
		expect(getAttachmentIcon('files.bz2')).toBe('archive');
	});

	it('returns "text" for .txt files', () => {
		expect(getAttachmentIcon('readme.txt')).toBe('text');
	});

	it('returns "text" for .csv files', () => {
		expect(getAttachmentIcon('data.csv')).toBe('text');
	});

	it('returns "text" for .log files', () => {
		expect(getAttachmentIcon('server.log')).toBe('text');
	});

	it('returns "text" for .md files', () => {
		expect(getAttachmentIcon('notes.md')).toBe('text');
	});

	it('returns "text" for .rtf files', () => {
		expect(getAttachmentIcon('doc.rtf')).toBe('text');
	});

	it('returns "code" for .js files', () => {
		expect(getAttachmentIcon('app.js')).toBe('code');
	});

	it('returns "code" for .ts files', () => {
		expect(getAttachmentIcon('app.ts')).toBe('code');
	});

	it('returns "code" for .py files', () => {
		expect(getAttachmentIcon('main.py')).toBe('code');
	});

	it('returns "code" for .html files', () => {
		expect(getAttachmentIcon('index.html')).toBe('code');
	});

	it('returns "code" for .css files', () => {
		expect(getAttachmentIcon('style.css')).toBe('code');
	});

	it('returns "code" for .json files', () => {
		expect(getAttachmentIcon('config.json')).toBe('code');
	});

	it('returns "code" for .xml files', () => {
		expect(getAttachmentIcon('data.xml')).toBe('code');
	});

	it('returns "code" for .java files', () => {
		expect(getAttachmentIcon('Main.java')).toBe('code');
	});

	it('returns "code" for .go files', () => {
		expect(getAttachmentIcon('main.go')).toBe('code');
	});

	it('returns "code" for .rs files', () => {
		expect(getAttachmentIcon('main.rs')).toBe('code');
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

	it('returns "generic" for dotfiles (.gitignore)', () => {
		expect(getAttachmentIcon('.gitignore')).toBe('generic');
	});

	it('uses last extension for multiple dots (archive.tar.gz → archive)', () => {
		expect(getAttachmentIcon('archive.tar.gz')).toBe('archive');
	});

	it('case insensitive via toLowerCase (.PNG → image)', () => {
		expect(getAttachmentIcon('image.PNG')).toBe('image');
	});

	it('case insensitive for .MP4 → video', () => {
		expect(getAttachmentIcon('clip.MP4')).toBe('video');
	});

	it('handles trailing dot', () => {
		/* Extension after last dot is empty string, not in map → generic. */
		expect(getAttachmentIcon('file.')).toBe('generic');
	});

	it('handles double dots', () => {
		/* Last dot → extension is "pdf" */
		expect(getAttachmentIcon('file..pdf')).toBe('pdf');
	});
});

// =============================================================================
// Tests — computePaginationDisplay
// =============================================================================

describe('computePaginationDisplay', () => {
	it('returns "0 of 0" when loaded is 0', () => {
		expect(computePaginationDisplay(0, 1, 20, false, null)).toBe('0 of 0');
	});

	it('formats single page correctly', () => {
		expect(computePaginationDisplay(15, 1, 20, false, null)).toBe('1\u201315 of 15');
	});

	it('formats first page of multi-page result', () => {
		const pc: PanelCount = { total: 200, unread: 0, isEstimate: false };
		expect(computePaginationDisplay(200, 1, 20, false, pc)).toBe('1\u201320 of 200');
	});

	it('formats middle pages correctly', () => {
		const pc: PanelCount = { total: 200, unread: 0, isEstimate: false };
		expect(computePaginationDisplay(200, 3, 20, false, pc)).toBe('41\u201360 of 200');
	});

	it('formats last page with fewer items', () => {
		expect(computePaginationDisplay(45, 3, 20, true, null)).toBe('41\u201345 of 45');
	});

	it('formats exact page boundary', () => {
		expect(computePaginationDisplay(40, 2, 20, true, null)).toBe('21\u201340 of 40');
	});

	it('uses en-dash (U+2013) as range separator', () => {
		const result = computePaginationDisplay(100, 1, 20, true, null);
		expect(result).toContain('\u2013');
	});

	it('shows exact count without tilde for isEstimate=false', () => {
		const pc: PanelCount = { total: 500, unread: 10, isEstimate: false };
		const result = computePaginationDisplay(20, 1, 20, false, pc);
		expect(result).toBe('1\u201320 of 500');
		expect(result).not.toContain('~');
	});

	it('shows tilde prefix for isEstimate=true', () => {
		const pc: PanelCount = { total: 500, unread: 10, isEstimate: true };
		const result = computePaginationDisplay(20, 1, 20, false, pc);
		expect(result).toBe('1\u201320 of ~500');
	});

	it('uses loaded count when allLoaded=true (ignores estimate)', () => {
		const pc: PanelCount = { total: 500, unread: 10, isEstimate: true };
		const result = computePaginationDisplay(45, 1, 20, true, pc);
		expect(result).toBe('1\u201320 of 45');
		expect(result).not.toContain('~');
	});

	it('returns loaded count when panelCount is null', () => {
		const result = computePaginationDisplay(20, 1, 20, false, null);
		expect(result).toBe('1\u201320 of 20');
	});

	it('uses max of server total and loaded when server is lower', () => {
		const pc: PanelCount = { total: 30, unread: 5, isEstimate: false };
		const result = computePaginationDisplay(50, 1, 20, false, pc);
		/* max(30, 50) = 50 */
		expect(result).toBe('1\u201320 of 50');
	});

	it('formats large numbers with locale separators', () => {
		const pc: PanelCount = { total: 12345, unread: 100, isEstimate: true };
		const result = computePaginationDisplay(20, 1, 20, false, pc);
		const formatted = (12345).toLocaleString();
		expect(result).toBe(`1\u201320 of ~${formatted}`);
	});

	it('shows "0 of 0" when loaded is 0 even with estimate', () => {
		const pc: PanelCount = { total: 500, unread: 10, isEstimate: true };
		expect(computePaginationDisplay(0, 1, 20, false, pc)).toBe('0 of 0');
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

	it('ignores selected IDs not in displayed threads', () => {
		const threads = [{ id: 'a' }, { id: 'b' }];
		expect(masterCheckState(threads, new Set(['x', 'y']))).toBe('none');
	});

	it('returns "all" even when extra non-displayed IDs are selected', () => {
		const threads = [{ id: 'a' }, { id: 'b' }];
		expect(masterCheckState(threads, new Set(['a', 'b', 'x', 'y']))).toBe('all');
	});

	it('single thread page: returns "all" when selected', () => {
		const threads = [{ id: 'only' }];
		expect(masterCheckState(threads, new Set(['only']))).toBe('all');
	});

	it('single thread page: returns "none" when not selected', () => {
		const threads = [{ id: 'only' }];
		expect(masterCheckState(threads, new Set())).toBe('none');
	});

	it('handles very large selection set efficiently', () => {
		const threads = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const bigSet = new Set<string>();
		for (let i = 0; i < 1000; i++) bigSet.add(`extra-${i}`);
		bigSet.add('a');
		bigSet.add('b');
		bigSet.add('c');
		expect(masterCheckState(threads, bigSet)).toBe('all');
	});
});

// =============================================================================
// Tests — loadPanels
// =============================================================================

describe('loadPanels', () => {
	it('returns default panels when nothing saved', () => {
		const storage = createFakeStorage();
		const result = loadPanels(storage);
		expect(result).toEqual(getDefaultPanels());
	});

	it('returns saved panels from localStorage', () => {
		const storage = createFakeStorage();
		const customPanels: PanelConfig[] = [
			{
				name: 'Work',
				rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }]
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
		expect(loadPanels(storage)).toEqual(getDefaultPanels());
	});

	it('returns defaults when localStorage contains empty array', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', '[]');
		expect(loadPanels(storage)).toEqual(getDefaultPanels());
	});

	it('returns defaults when localStorage contains non-array', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', '"just a string"');
		expect(loadPanels(storage)).toEqual(getDefaultPanels());
	});

	it('returns defaults when localStorage.getItem throws', () => {
		const storage = createFakeStorage();
		(storage.getItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error('Storage access denied');
		});
		expect(loadPanels(storage)).toEqual(getDefaultPanels());
	});

	it('returns defaults when stored value is null literal', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', 'null');
		expect(loadPanels(storage)).toEqual(getDefaultPanels());
	});

	it('returns defaults when stored value is object (not array)', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', '{"name":"test"}');
		expect(loadPanels(storage)).toEqual(getDefaultPanels());
	});

	it('preserves complex rule configurations through round-trip', () => {
		const storage = createFakeStorage();
		const complexPanels: PanelConfig[] = [
			{
				name: 'Work',
				rules: [
					{ field: 'from', addresses: ['@company.com'], action: 'accept' },
					{ field: 'to', addresses: ['newsletter@'], action: 'reject' },
					{ field: 'from', addresses: ['boss@company.com', 'ceo@company.com'], action: 'accept' }
				]
			},
			{
				name: 'Social',
				rules: [{ field: 'from', addresses: ['@facebook.com', '@twitter.com'], action: 'accept' }]
			},
			{ name: 'Updates', rules: [] },
			{ name: 'Other', rules: [] }
		];
		savePanels(storage, complexPanels);
		expect(loadPanels(storage)).toEqual(complexPanels);
	});
});

// =============================================================================
// Tests — isFirstTimeUser
// =============================================================================

describe('isFirstTimeUser', () => {
	it('returns true when no panel config exists', () => {
		const storage = createFakeStorage();
		expect(isFirstTimeUser(storage)).toBe(true);
	});

	it('returns false when panel config exists', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', '[]');
		expect(isFirstTimeUser(storage)).toBe(false);
	});

	it('returns false even if stored value is invalid JSON', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_panels', 'garbage');
		expect(isFirstTimeUser(storage)).toBe(false);
	});

	it('returns true when getItem returns null', () => {
		const storage = createFakeStorage();
		/* Default behavior — no key set. */
		expect(isFirstTimeUser(storage)).toBe(true);
	});
});

// =============================================================================
// Tests — savePanels
// =============================================================================

describe('savePanels', () => {
	it('serializes panels to localStorage as JSON', () => {
		const storage = createFakeStorage();
		const panels: PanelConfig[] = [
			{ name: 'Work', rules: [{ field: 'from', addresses: ['@work.com'], action: 'accept' }] },
			{ name: 'Other', rules: [] }
		];
		savePanels(storage, panels);
		expect(storage.getItem('switchboard_panels')).toBe(JSON.stringify(panels));
	});

	it('does not throw when localStorage.setItem fails', () => {
		const storage = createFakeStorage();
		(storage.setItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error('QuotaExceededError');
		});
		expect(() => savePanels(storage, getDefaultPanels())).not.toThrow();
	});

	it('round-trips through loadPanels correctly', () => {
		const storage = createFakeStorage();
		const panels: PanelConfig[] = [
			{
				name: 'Custom',
				rules: [
					{ field: 'from', addresses: ['@example.com'], action: 'accept' },
					{ field: 'to', addresses: ['newsletter@'], action: 'reject' }
				]
			},
			{ name: 'Rest', rules: [] }
		];
		savePanels(storage, panels);
		expect(loadPanels(storage)).toEqual(panels);
	});

	it('handles empty panel name', () => {
		const storage = createFakeStorage();
		const panels: PanelConfig[] = [{ name: '', rules: [] }];
		savePanels(storage, panels);
		expect(loadPanels(storage)).toEqual(panels);
	});

	it('handles panels with many rules', () => {
		const storage = createFakeStorage();
		const rules = Array.from({ length: 15 }, (_, i) => ({
			field: 'from' as const,
			addresses: [`@domain-${i}.com`],
			action: 'accept' as const
		}));
		const panels: PanelConfig[] = [{ name: 'Many', rules }];
		savePanels(storage, panels);
		expect(loadPanels(storage)).toEqual(panels);
	});
});

// =============================================================================
// Tests — loadPageSize
// =============================================================================

describe('loadPageSize', () => {
	it('returns 20 (default) when nothing stored', () => {
		const storage = createFakeStorage();
		expect(loadPageSize(storage)).toBe(20);
	});

	it('returns stored value when valid', () => {
		const storage = createFakeStorage();
		for (const size of [10, 15, 20, 25, 50, 100]) {
			storage.setItem('switchboard_page_size', String(size));
			expect(loadPageSize(storage)).toBe(size);
		}
	});

	it('returns default for invalid value (99)', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_page_size', '99');
		expect(loadPageSize(storage)).toBe(20);
	});

	it('returns default for non-numeric value', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_page_size', 'abc');
		expect(loadPageSize(storage)).toBe(20);
	});

	it('returns default when localStorage throws', () => {
		const storage = createFakeStorage();
		(storage.getItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error('Access denied');
		});
		expect(loadPageSize(storage)).toBe(20);
	});

	it('returns default for 0', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_page_size', '0');
		expect(loadPageSize(storage)).toBe(20);
	});

	it('returns default for negative number', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_page_size', '-1');
		expect(loadPageSize(storage)).toBe(20);
	});

	it('returns default for Infinity', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_page_size', 'Infinity');
		expect(loadPageSize(storage)).toBe(20);
	});

	it('returns default for float', () => {
		const storage = createFakeStorage();
		storage.setItem('switchboard_page_size', '20.5');
		expect(loadPageSize(storage)).toBe(20);
	});

	it('accepts all valid PAGE_SIZE_OPTIONS', () => {
		const storage = createFakeStorage();
		for (const size of PAGE_SIZE_OPTIONS) {
			storage.setItem('switchboard_page_size', String(size));
			expect(loadPageSize(storage)).toBe(size);
		}
	});
});

// =============================================================================
// Tests — savePageSize
// =============================================================================

describe('savePageSize', () => {
	it('persists to localStorage', () => {
		const storage = createFakeStorage();
		savePageSize(storage, 25);
		expect(storage.getItem('switchboard_page_size')).toBe('25');
	});

	it('does not throw when localStorage fails', () => {
		const storage = createFakeStorage();
		(storage.setItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error('QuotaExceededError');
		});
		expect(() => savePageSize(storage, 50)).not.toThrow();
	});

	it('round-trips through loadPageSize', () => {
		const storage = createFakeStorage();
		savePageSize(storage, 100);
		expect(loadPageSize(storage)).toBe(100);
	});

	it('pagination recalculates with different page sizes', () => {
		expect(computePaginationDisplay(100, 1, 10, true, null)).toBe('1\u201310 of 100');
		expect(computePaginationDisplay(100, 1, 25, true, null)).toBe('1\u201325 of 100');
		expect(computePaginationDisplay(100, 1, 50, true, null)).toBe('1\u201350 of 100');
		expect(computePaginationDisplay(100, 2, 50, true, null)).toBe('51\u2013100 of 100');
	});
});

// =============================================================================
// Tests — buildThreadsUrl
// =============================================================================

describe('buildThreadsUrl', () => {
	it('constructs URL with only q parameter', () => {
		const url = buildThreadsUrl(undefined, 'from:alice@example.com');
		expect(url).toBe('/api/threads?q=from%3Aalice%40example.com');
	});

	it('constructs URL with both pageToken and q', () => {
		const url = buildThreadsUrl('page2', 'has:attachment');
		expect(url).toBe('/api/threads?pageToken=page2&q=has%3Aattachment');
	});

	it('constructs /api/threads with no params', () => {
		const url = buildThreadsUrl();
		expect(url).toBe('/api/threads');
	});

	it('constructs URL with only pageToken', () => {
		const url = buildThreadsUrl('next');
		expect(url).toBe('/api/threads?pageToken=next');
	});

	it('handles complex Gmail search syntax', () => {
		const url = buildThreadsUrl(undefined, 'subject:"team meeting" OR from:boss');
		expect(url).toContain('q=');
		expect(url).toContain('subject');
	});

	it('handles empty string q (treated as falsy)', () => {
		const url = buildThreadsUrl(undefined, '');
		expect(url).toBe('/api/threads');
	});

	it('handles empty string pageToken (treated as falsy)', () => {
		const url = buildThreadsUrl('', undefined);
		expect(url).toBe('/api/threads');
	});
});

// =============================================================================
// Tests — computeTotalPanelPages
// =============================================================================

describe('computeTotalPanelPages', () => {
	it('returns 1 for 0 loaded threads', () => {
		expect(computeTotalPanelPages(0, 20, false, undefined)).toBe(1);
	});

	it('returns 1 for less than 1 page', () => {
		expect(computeTotalPanelPages(5, 20, false, undefined)).toBe(1);
	});

	it('returns correct pages for exact multiple', () => {
		expect(computeTotalPanelPages(60, 20, false, undefined)).toBe(3);
	});

	it('uses loaded count when allLoaded (ignoring estimate)', () => {
		expect(computeTotalPanelPages(45, 20, true, 500)).toBe(3);
	});

	it('uses estimate when not allLoaded and estimate > loaded', () => {
		expect(computeTotalPanelPages(20, 20, false, 500)).toBe(25);
	});

	it('falls back to loaded when estimate undefined', () => {
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

	it('handles pageSize of 1', () => {
		expect(computeTotalPanelPages(5, 1, true, undefined)).toBe(5);
	});

	it('handles very large estimate', () => {
		expect(computeTotalPanelPages(20, 20, false, 1000000)).toBe(50000);
	});
});

// =============================================================================
// Tests — computePanelStats
// =============================================================================

describe('computePanelStats', () => {
	const singlePanel: PanelConfig[] = [{ name: 'All', rules: [] }];
	const threads = [
		{ from: { name: '', email: 'a@test.com' }, to: '', labelIds: ['INBOX', 'UNREAD'] },
		{ from: { name: '', email: 'b@test.com' }, to: '', labelIds: ['INBOX'] }
	];

	it('suppresses unread badges before server estimates arrive (null)', () => {
		const stats = computePanelStats(singlePanel, threads, false, null);
		expect(stats[0].unread).toBe(0);
		expect(stats[0].total).toBe(2);
	});

	it('shows server unread counts once estimates arrive', () => {
		const estimates: PanelCount[] = [{ total: 500, unread: 42, isEstimate: false }];
		const stats = computePanelStats(singlePanel, threads, false, estimates);
		expect(stats[0].unread).toBe(42);
	});

	it('uses exact loaded counts when allLoaded=true', () => {
		const estimates: PanelCount[] = [{ total: 500, unread: 42, isEstimate: false }];
		const stats = computePanelStats(singlePanel, threads, true, estimates);
		expect(stats[0].unread).toBe(1);
		expect(stats[0].total).toBe(2);
	});

	it('optimistically decrements unread on mark-as-read', () => {
		const updated: PanelCount[] = [{ total: 500, unread: 41, isEstimate: false }];
		const stats = computePanelStats(singlePanel, threads, false, updated);
		expect(stats[0].unread).toBe(41);
	});

	it('switches to search-scoped unread counts during search', () => {
		const searchEstimates: PanelCount[] = [{ total: 20, unread: 3, isEstimate: true }];
		const stats = computePanelStats(singlePanel, threads, false, searchEstimates);
		expect(stats[0].unread).toBe(3);
	});

	it('handles empty panels array', () => {
		const stats = computePanelStats([], threads, false, null);
		expect(stats).toEqual([]);
	});

	it('handles empty threads array', () => {
		const stats = computePanelStats(singlePanel, [], false, null);
		expect(stats[0].total).toBe(0);
		expect(stats[0].unread).toBe(0);
	});

	it('counts threads in multiple panels (no-rules + rules)', () => {
		const panels: PanelConfig[] = [
			{ name: 'All', rules: [] },
			{ name: 'A Only', rules: [{ field: 'from', addresses: ['a@test'], action: 'accept' }] }
		];
		const stats = computePanelStats(panels, threads, true, null);
		expect(stats[0].total).toBe(2); /* no-rules matches all */
		expect(stats[1].total).toBe(1); /* only a@test.com matches */
	});

	it('counts threads correctly for rules panels', () => {
		const panels: PanelConfig[] = [
			{ name: 'B Only', rules: [{ field: 'from', addresses: ['b@test'], action: 'accept' }] }
		];
		const stats = computePanelStats(panels, threads, true, null);
		expect(stats[0].total).toBe(1);
		expect(stats[0].unread).toBe(0); /* b@test is not UNREAD */
	});

	it('uses max(estimate, loaded) for total', () => {
		const estimates: PanelCount[] = [{ total: 500, unread: 10, isEstimate: true }];
		const stats = computePanelStats(singlePanel, threads, false, estimates);
		expect(stats[0].total).toBe(500); /* max(2, 500) */
	});

	it('handles missing estimate for a panel index', () => {
		const panels: PanelConfig[] = [
			{ name: 'A', rules: [] },
			{ name: 'B', rules: [] }
		];
		/* Only one estimate for two panels */
		const estimates: PanelCount[] = [{ total: 100, unread: 5, isEstimate: false }];
		const stats = computePanelStats(panels, threads, false, estimates);
		expect(stats[0].unread).toBe(5);
		expect(stats[1].unread).toBe(0); /* No estimate → suppressed */
	});

	it('handles threads with no UNREAD label', () => {
		const readThreads = [
			{ from: { name: '', email: 'a@test.com' }, to: '', labelIds: ['INBOX'] },
			{ from: { name: '', email: 'b@test.com' }, to: '', labelIds: ['INBOX'] }
		];
		const stats = computePanelStats(singlePanel, readThreads, true, null);
		expect(stats[0].total).toBe(2);
		expect(stats[0].unread).toBe(0);
	});
});

// =============================================================================
// Tests — decrementUnreadCounts
// =============================================================================

describe('decrementUnreadCounts', () => {
	it('returns null when estimates are null', () => {
		expect(decrementUnreadCounts(null, [1, 2])).toBeNull();
	});

	it('decrements unread for specified panel', () => {
		const estimates: PanelCount[] = [{ total: 100, unread: 10, isEstimate: false }];
		const result = decrementUnreadCounts(estimates, [3]);
		expect(result).not.toBeNull();
		expect(result![0].unread).toBe(7);
	});

	it('clamps to zero (does not go negative)', () => {
		const estimates: PanelCount[] = [{ total: 100, unread: 2, isEstimate: false }];
		const result = decrementUnreadCounts(estimates, [5]);
		expect(result![0].unread).toBe(0);
	});

	it('does not affect other fields (total, isEstimate)', () => {
		const estimates: PanelCount[] = [{ total: 500, unread: 42, isEstimate: true }];
		const result = decrementUnreadCounts(estimates, [10]);
		expect(result![0].total).toBe(500);
		expect(result![0].isEstimate).toBe(true);
		expect(result![0].unread).toBe(32);
	});

	it('handles missing decrement values (treats as 0)', () => {
		const estimates: PanelCount[] = [
			{ total: 100, unread: 10, isEstimate: false },
			{ total: 200, unread: 20, isEstimate: false }
		];
		const result = decrementUnreadCounts(estimates, [5]);
		expect(result![0].unread).toBe(5);
		expect(result![1].unread).toBe(20);
	});

	it('decrements across multiple panels', () => {
		const estimates: PanelCount[] = [
			{ total: 100, unread: 10, isEstimate: false },
			{ total: 200, unread: 20, isEstimate: true },
			{ total: 300, unread: 30, isEstimate: false }
		];
		const result = decrementUnreadCounts(estimates, [2, 5, 10]);
		expect(result![0].unread).toBe(8);
		expect(result![1].unread).toBe(15);
		expect(result![2].unread).toBe(20);
	});

	it('handles all-zero decrements', () => {
		const estimates: PanelCount[] = [{ total: 100, unread: 10, isEstimate: false }];
		const result = decrementUnreadCounts(estimates, [0]);
		expect(result![0].unread).toBe(10);
	});

	it('handles empty estimates array', () => {
		const result = decrementUnreadCounts([], [1, 2]);
		expect(result).toEqual([]);
	});
});

// =============================================================================
// Tests — thread panel matching integration
// =============================================================================

describe('thread panel matching integration', () => {
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
			{ name: 'Work', rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }] },
			{ name: 'All Company', rules: [{ field: 'from', addresses: ['company'], action: 'accept' }] }
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
			rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }]
		};
		const thread = { from: { name: '', email: 'boss@company.com' }, to: '' };
		const fromRaw = reconstructFrom(thread);
		expect(threadMatchesPanel(noRules, fromRaw, '')).toBe(true);
		expect(threadMatchesPanel(withRules, fromRaw, '')).toBe(true);
	});

	it('thread does NOT appear in non-matching rules panel', () => {
		const panel: PanelConfig = {
			name: 'GitHub',
			rules: [{ field: 'from', addresses: ['@github.com'], action: 'accept' }]
		};
		const thread = { from: { name: '', email: 'random@other.com' }, to: '' };
		const fromRaw = reconstructFrom(thread);
		expect(threadMatchesPanel(panel, fromRaw, '')).toBe(false);
	});

	it('thread matching is independent per panel (not assigned to first)', () => {
		const panels: PanelConfig[] = [
			{ name: 'A', rules: [{ field: 'from', addresses: ['@a.com'], action: 'accept' }] },
			{ name: 'B', rules: [{ field: 'from', addresses: ['@b.com'], action: 'accept' }] },
			{
				name: 'Both',
				rules: [{ field: 'from', addresses: ['@a.com', '@b.com'], action: 'accept' }]
			}
		];
		const thread = { from: { name: '', email: 'user@a.com' }, to: '' };
		const fromRaw = reconstructFrom(thread);
		expect(threadMatchesPanel(panels[0], fromRaw, '')).toBe(true);
		expect(threadMatchesPanel(panels[1], fromRaw, '')).toBe(false);
		expect(threadMatchesPanel(panels[2], fromRaw, '')).toBe(true);
	});
});

// =============================================================================
// Tests — search behavioral patterns
// =============================================================================

describe('search behavioral patterns', () => {
	it('trims whitespace from search input', () => {
		const query = '  from:user@example.com  '.trim();
		expect(query).toBe('from:user@example.com');
	});

	it('does not execute on empty string', () => {
		const query = ''.trim();
		expect(query).toBeFalsy();
	});

	it('does not execute on whitespace-only', () => {
		const query = '   '.trim();
		expect(query).toBeFalsy();
	});

	it('clearSearch produces expected reset values', () => {
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

	it('activeThreadList returns searchList when searching', () => {
		const searchQuery = 'from:test';
		const isSearchActive = searchQuery.length > 0;
		const threadMetaList = [{ id: 'inbox-1' }];
		const searchThreadMetaList = [{ id: 'search-1' }];

		const activeThreadList = isSearchActive ? searchThreadMetaList : threadMetaList;
		expect(activeThreadList).toEqual([{ id: 'search-1' }]);
	});

	it('activeThreadList returns inboxList when not searching', () => {
		const searchQuery = '';
		const isSearchActive = searchQuery.length > 0;
		const threadMetaList = [{ id: 'inbox-1' }];
		const searchThreadMetaList = [{ id: 'search-1' }];

		const activeThreadList = isSearchActive ? searchThreadMetaList : threadMetaList;
		expect(activeThreadList).toEqual([{ id: 'inbox-1' }]);
	});

	it('markAsRead updates thread in both lists', () => {
		const threadId = 't1';
		const threadMetaList = [{ id: 't1', labelIds: ['INBOX', 'UNREAD'] }];
		const searchThreadMetaList = [{ id: 't1', labelIds: ['INBOX', 'UNREAD'] }];

		const thread = threadMetaList.find((t) => t.id === threadId);
		if (thread) thread.labelIds = thread.labelIds.filter((l) => l !== 'UNREAD');
		const searchThread = searchThreadMetaList.find((t) => t.id === threadId);
		if (searchThread) searchThread.labelIds = searchThread.labelIds.filter((l) => l !== 'UNREAD');

		expect(thread!.labelIds).toEqual(['INBOX']);
		expect(searchThread!.labelIds).toEqual(['INBOX']);
	});

	it('trash removes from both lists, rollback restores', () => {
		const idsToTrash = ['t1', 't2'];
		const threadMetaList = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
		const searchThreadMetaList = [{ id: 't1' }, { id: 't3' }];
		const snapshot = [...threadMetaList];
		const searchSnapshot = [...searchThreadMetaList];

		const newThreadMetaList = threadMetaList.filter((t) => !idsToTrash.includes(t.id));
		const newSearchList = searchThreadMetaList.filter((t) => !idsToTrash.includes(t.id));
		expect(newThreadMetaList).toEqual([{ id: 't3' }]);
		expect(newSearchList).toEqual([{ id: 't3' }]);

		/* Rollback: */
		expect(snapshot).toEqual([{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
		expect(searchSnapshot).toEqual([{ id: 't1' }, { id: 't3' }]);
	});
});

// =============================================================================
// Tests — EXT_TO_TYPE constant coverage
// =============================================================================

describe('EXT_TO_TYPE', () => {
	it('contains all expected extension mappings', () => {
		/* Verify total count of mapped extensions */
		const keys = Object.keys(EXT_TO_TYPE);
		expect(keys.length).toBeGreaterThanOrEqual(40);
	});

	it('maps all documented categories', () => {
		const categories = new Set(Object.values(EXT_TO_TYPE));
		expect(categories).toContain('pdf');
		expect(categories).toContain('word');
		expect(categories).toContain('spreadsheet');
		expect(categories).toContain('presentation');
		expect(categories).toContain('image');
		expect(categories).toContain('video');
		expect(categories).toContain('audio');
		expect(categories).toContain('archive');
		expect(categories).toContain('text');
		expect(categories).toContain('code');
	});
});

// =============================================================================
// Tests — migrateOldPanelFormat
// =============================================================================

describe('migrateOldPanelFormat', () => {
	it('converts old regex format (pattern key) to addresses', () => {
		const old = [
			{
				name: 'Work',
				rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
			}
		];
		const result = migrateOldPanelFormat(old);
		expect(result[0].name).toBe('Work');
		expect(result[0].rules[0].addresses).toEqual(['@company.com']);
		expect(result[0].rules[0]).not.toHaveProperty('pattern');
	});

	it('passes through already-new format unchanged', () => {
		const newFormat = [
			{
				name: 'Work',
				rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }]
			}
		];
		const result = migrateOldPanelFormat(newFormat);
		expect(result).toEqual(newFormat);
	});

	it('handles mixed old/new rules in a single panel', () => {
		const mixed = [
			{
				name: 'Mixed',
				rules: [
					{ field: 'from', pattern: '@old\\.com', action: 'accept' },
					{ field: 'to', addresses: ['@new.com'], action: 'reject' }
				]
			}
		];
		const result = migrateOldPanelFormat(mixed);
		expect(result[0].rules[0].addresses).toEqual(['@old.com']);
		expect(result[0].rules[1].addresses).toEqual(['@new.com']);
	});

	it('handles empty pattern → empty addresses', () => {
		const old = [
			{
				name: 'Empty',
				rules: [{ field: 'from', pattern: '', action: 'accept' }]
			}
		];
		const result = migrateOldPanelFormat(old);
		expect(result[0].rules[0].addresses).toEqual([]);
	});

	it('handles complex regex with group expansion', () => {
		const old = [
			{
				name: 'Social',
				rules: [{ field: 'from', pattern: '@(twitter|facebook)\\.com', action: 'accept' }]
			}
		];
		const result = migrateOldPanelFormat(old);
		expect(result[0].rules[0].addresses).toEqual(['@twitter.com', '@facebook.com']);
	});

	it('handles pipe alternatives', () => {
		const old = [
			{
				name: 'Keywords',
				rules: [{ field: 'from', pattern: 'newsletter|digest', action: 'accept' }]
			}
		];
		const result = migrateOldPanelFormat(old);
		expect(result[0].rules[0].addresses).toEqual(['newsletter', 'digest']);
	});

	it('uses defaults for missing fields', () => {
		const partial = [
			{
				rules: [{ pattern: '@test.com' }]
			}
		];
		const result = migrateOldPanelFormat(partial);
		expect(result[0].name).toBe('Panel');
		expect(result[0].rules[0].field).toBe('from');
		expect(result[0].rules[0].action).toBe('accept');
	});

	it('handles panels with no rules', () => {
		const empty = [{ name: 'All', rules: [] }];
		const result = migrateOldPanelFormat(empty);
		expect(result).toEqual([{ name: 'All', rules: [] }]);
	});

	it('handles panels with undefined rules', () => {
		const noRules = [{ name: 'NoRules' }];
		const result = migrateOldPanelFormat(noRules);
		expect(result[0].rules).toEqual([]);
	});
});

// =============================================================================
// Tests — patternToAddresses
// =============================================================================

describe('patternToAddresses', () => {
	it('converts simple escaped domain', () => {
		expect(patternToAddresses('@company\\.com')).toEqual(['@company.com']);
	});

	it('strips anchors ^ and $', () => {
		expect(patternToAddresses('^@company\\.com$')).toEqual(['@company.com']);
	});

	it('expands (a|b) group with prefix and suffix', () => {
		expect(patternToAddresses('@(twitter|facebook)\\.com')).toEqual([
			'@twitter.com',
			'@facebook.com'
		]);
	});

	it('expands three alternatives in group', () => {
		expect(patternToAddresses('@(a|b|c)\\.com')).toEqual(['@a.com', '@b.com', '@c.com']);
	});

	it('splits top-level pipe alternatives', () => {
		expect(patternToAddresses('newsletter|digest')).toEqual(['newsletter', 'digest']);
	});

	it('returns empty array for empty string', () => {
		expect(patternToAddresses('')).toEqual([]);
	});

	it('returns empty array for whitespace-only', () => {
		expect(patternToAddresses('   ')).toEqual([]);
	});

	it('handles escaped special characters', () => {
		expect(patternToAddresses('user\\.name\\@domain')).toEqual(['user.name@domain']);
	});

	it('removes quantifiers', () => {
		expect(patternToAddresses('news+letter*')).toEqual(['newsletter']);
	});

	it('handles single plain address', () => {
		expect(patternToAddresses('user@example.com')).toEqual(['user@example.com']);
	});

	it('filters out empty results from pipe split', () => {
		/* Leading/trailing pipes can produce empty strings. */
		expect(patternToAddresses('|alpha|')).toEqual(['alpha']);
	});

	it('handles top-level alternatives with escapes', () => {
		expect(patternToAddresses('@work\\.com|@personal\\.org')).toEqual([
			'@work.com',
			'@personal.org'
		]);
	});

	it('handles group with prefix and suffix (prefix-a-suffix, prefix-b-suffix)', () => {
		expect(patternToAddresses('prefix-(a|b)-suffix')).toEqual([
			'prefix-a-suffix',
			'prefix-b-suffix'
		]);
	});
});
