/**
 * @fileoverview Unit tests for inbox data management utilities.
 *
 * Tests cover:
 *   - mergeThreads 'refresh' mode:
 *       • Updates existing threads with fresh server data
 *       • Adds new threads not in the local list (prepends)
 *       • Does NOT remove local threads missing from server response
 *       • Returns same reference when server list is empty
 *       • Handles empty existing list (adds all)
 *       • Preserves order of existing threads
 *       • Updates multiple fields (labels, snippet, date)
 *   - mergeThreads 'append' mode:
 *       • Appends new threads to the end
 *       • Deduplicates by thread ID (skips already-present threads)
 *       • Returns same reference when all server threads are duplicates
 *       • Returns same reference when server list is empty
 *       • Handles empty existing list (adds all)
 *       • Does not modify existing threads even if server version differs
 */

import { describe, it, expect } from 'vitest';
import { mergeThreads } from './inbox.js';
import type { ThreadMetadata } from './types.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal ThreadMetadata object for testing.
 * Only the fields used by mergeThreads are populated.
 */
function makeThread(overrides: Partial<ThreadMetadata> & { id: string }): ThreadMetadata {
	return {
		id: overrides.id,
		subject: overrides.subject ?? `Subject ${overrides.id}`,
		from: overrides.from ?? { name: 'Test', email: 'test@example.com' },
		to: overrides.to ?? 'user@example.com',
		date: overrides.date ?? '2026-02-12T10:00:00Z',
		snippet: overrides.snippet ?? `Snippet for ${overrides.id}`,
		labelIds: overrides.labelIds ?? ['INBOX'],
		messageCount: overrides.messageCount ?? 1
	};
}

// =============================================================================
// Refresh Mode
// =============================================================================

describe('mergeThreads — refresh mode', () => {
	it('updates existing threads with fresh server data', () => {
		const existing = [
			makeThread({ id: 'a', labelIds: ['INBOX', 'UNREAD'], snippet: 'old' }),
			makeThread({ id: 'b', snippet: 'old b' })
		];

		const server = [
			makeThread({ id: 'a', labelIds: ['INBOX'], snippet: 'new' }),
			makeThread({ id: 'b', snippet: 'new b' })
		];

		const result = mergeThreads(existing, server, 'refresh');

		/* Thread 'a' should have updated labels (UNREAD removed). */
		const threadA = result.find((t) => t.id === 'a')!;
		expect(threadA.labelIds).toEqual(['INBOX']);
		expect(threadA.snippet).toBe('new');

		/* Thread 'b' should have updated snippet. */
		const threadB = result.find((t) => t.id === 'b')!;
		expect(threadB.snippet).toBe('new b');
	});

	it('adds new threads not in the local list (prepended)', () => {
		const existing = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];

		const server = [
			makeThread({ id: 'c', subject: 'New email' }),
			makeThread({ id: 'a' }) /* existing — will update */
		];

		const result = mergeThreads(existing, server, 'refresh');

		/* Should have 3 threads: new 'c' prepended, then 'a' and 'b'. */
		expect(result.length).toBe(3);
		expect(result[0].id).toBe('c');
		expect(result[0].subject).toBe('New email');
	});

	it('does NOT remove local threads missing from server response', () => {
		/*
		 * Page 1 refresh might not include threads that are on page 2+.
		 * We must NOT delete them from the local list.
		 */
		const existing = [makeThread({ id: 'a' }), makeThread({ id: 'b' }), makeThread({ id: 'c' })];

		/* Server page 1 only returns 'a' — 'b' and 'c' are on later pages. */
		const server = [makeThread({ id: 'a', snippet: 'refreshed' })];

		const result = mergeThreads(existing, server, 'refresh');

		expect(result.length).toBe(3);
		expect(result.find((t) => t.id === 'a')!.snippet).toBe('refreshed');
		expect(result.find((t) => t.id === 'b')).toBeDefined();
		expect(result.find((t) => t.id === 'c')).toBeDefined();
	});

	it('returns same reference when server list is empty', () => {
		const existing = [makeThread({ id: 'a' })];
		const result = mergeThreads(existing, [], 'refresh');
		expect(result).toBe(existing);
	});

	it('handles empty existing list (adds all server threads)', () => {
		const server = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];
		const result = mergeThreads([], server, 'refresh');

		expect(result.length).toBe(2);
		expect(result[0].id).toBe('a');
		expect(result[1].id).toBe('b');
	});

	it('preserves order of existing threads (new ones prepended)', () => {
		const existing = [
			makeThread({ id: 'b', date: '2026-02-11T10:00:00Z' }),
			makeThread({ id: 'c', date: '2026-02-10T10:00:00Z' })
		];

		const server = [
			makeThread({ id: 'a', date: '2026-02-12T10:00:00Z' }),
			makeThread({ id: 'b', date: '2026-02-11T10:00:00Z' })
		];

		const result = mergeThreads(existing, server, 'refresh');

		/* New thread 'a' is prepended, then existing order 'b', 'c'. */
		expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c']);
	});

	it('updates multiple fields simultaneously', () => {
		const existing = [
			makeThread({
				id: 'a',
				subject: 'Old Subject',
				snippet: 'old snippet',
				labelIds: ['INBOX', 'UNREAD'],
				date: '2026-02-11T10:00:00Z',
				messageCount: 1
			})
		];

		const server = [
			makeThread({
				id: 'a',
				subject: 'Old Subject' /* unchanged */,
				snippet: 'new reply snippet',
				labelIds: ['INBOX'] /* UNREAD removed */,
				date: '2026-02-12T15:00:00Z' /* newer date */,
				messageCount: 3 /* more messages */
			})
		];

		const result = mergeThreads(existing, server, 'refresh');

		const thread = result[0];
		expect(thread.snippet).toBe('new reply snippet');
		expect(thread.labelIds).toEqual(['INBOX']);
		expect(thread.date).toBe('2026-02-12T15:00:00Z');
		expect(thread.messageCount).toBe(3);
	});

	it('returns a new array reference even when only updating', () => {
		const existing = [makeThread({ id: 'a' })];
		const server = [makeThread({ id: 'a', snippet: 'updated' })];

		const result = mergeThreads(existing, server, 'refresh');
		expect(result).not.toBe(existing);
	});

	it('handles large mix of new, existing, and missing threads', () => {
		/* Simulate a realistic scenario: 200 cached threads, page 1 returns 50. */
		const existing = Array.from({ length: 200 }, (_, i) =>
			makeThread({ id: `thread-${i}`, snippet: `cached-${i}` })
		);

		/* Page 1 returns 50 threads: 45 existing (updated) + 5 new. */
		const server = [
			...Array.from({ length: 5 }, (_, i) =>
				makeThread({ id: `new-${i}`, snippet: `brand-new-${i}` })
			),
			...Array.from({ length: 45 }, (_, i) =>
				makeThread({ id: `thread-${i}`, snippet: `refreshed-${i}` })
			)
		];

		const result = mergeThreads(existing, server, 'refresh');

		/* 5 new + 200 existing = 205 total (no removals). */
		expect(result.length).toBe(205);

		/* New threads are at the front. */
		expect(result[0].id).toBe('new-0');
		expect(result[4].id).toBe('new-4');

		/* Existing threads that were in the server response are updated. */
		const refreshed = result.find((t) => t.id === 'thread-0')!;
		expect(refreshed.snippet).toBe('refreshed-0');

		/* Existing threads NOT in the server response are unchanged. */
		const untouched = result.find((t) => t.id === 'thread-100')!;
		expect(untouched.snippet).toBe('cached-100');
	});
});

// =============================================================================
// Append Mode
// =============================================================================

describe('mergeThreads — append mode', () => {
	it('appends new threads to the end', () => {
		const existing = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];
		const server = [makeThread({ id: 'c' }), makeThread({ id: 'd' })];

		const result = mergeThreads(existing, server, 'append');

		expect(result.length).toBe(4);
		expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('deduplicates by thread ID (skips already-present threads)', () => {
		const existing = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];

		/* Server returns 'b' (duplicate) and 'c' (new). */
		const server = [makeThread({ id: 'b', snippet: 'newer' }), makeThread({ id: 'c' })];

		const result = mergeThreads(existing, server, 'append');

		expect(result.length).toBe(3);
		expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c']);
	});

	it('does not modify existing threads even if server version differs', () => {
		const existing = [makeThread({ id: 'a', snippet: 'original', labelIds: ['UNREAD'] })];
		const server = [makeThread({ id: 'a', snippet: 'updated', labelIds: [] })];

		const result = mergeThreads(existing, server, 'append');

		/* In append mode, existing threads are NOT updated. */
		expect(result.length).toBe(1);
		expect(result[0].snippet).toBe('original');
		expect(result[0].labelIds).toEqual(['UNREAD']);
	});

	it('returns same reference when all server threads are duplicates', () => {
		const existing = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];
		const server = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];

		const result = mergeThreads(existing, server, 'append');
		expect(result).toBe(existing);
	});

	it('returns same reference when server list is empty', () => {
		const existing = [makeThread({ id: 'a' })];
		const result = mergeThreads(existing, [], 'append');
		expect(result).toBe(existing);
	});

	it('handles empty existing list (adds all server threads)', () => {
		const server = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];
		const result = mergeThreads([], server, 'append');

		expect(result.length).toBe(2);
		expect(result[0].id).toBe('a');
		expect(result[1].id).toBe('b');
	});

	it('preserves exact order of existing threads', () => {
		const existing = [makeThread({ id: 'c' }), makeThread({ id: 'a' }), makeThread({ id: 'b' })];

		const server = [makeThread({ id: 'd' })];
		const result = mergeThreads(existing, server, 'append');

		expect(result.map((t) => t.id)).toEqual(['c', 'a', 'b', 'd']);
	});

	it('handles multiple pages of appends without duplicates', () => {
		/* Simulate 3 successive pagination appends. */
		let list: ThreadMetadata[] = [];

		const page1 = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];
		list = mergeThreads(list, page1, 'append');
		expect(list.length).toBe(2);

		const page2 = [makeThread({ id: 'c' }), makeThread({ id: 'd' })];
		list = mergeThreads(list, page2, 'append');
		expect(list.length).toBe(4);

		/* Page 3 has overlap with page 2 (edge case from server). */
		const page3 = [makeThread({ id: 'd' }), makeThread({ id: 'e' })];
		list = mergeThreads(list, page3, 'append');
		expect(list.length).toBe(5);
		expect(list.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('mergeThreads — edge cases', () => {
	it('both existing and server lists are empty', () => {
		const result = mergeThreads([], [], 'refresh');
		expect(result).toEqual([]);
	});

	it('both existing and server lists are empty (append mode)', () => {
		const result = mergeThreads([], [], 'append');
		expect(result).toEqual([]);
	});

	it('single thread update in refresh mode', () => {
		const existing = [makeThread({ id: 'only', snippet: 'v1' })];
		const server = [makeThread({ id: 'only', snippet: 'v2' })];

		const result = mergeThreads(existing, server, 'refresh');
		expect(result.length).toBe(1);
		expect(result[0].snippet).toBe('v2');
	});

	it('refresh then append simulates real page-load flow', () => {
		/* Step 1: Cache has old data. */
		let list = [
			makeThread({ id: 'a', snippet: 'cached-a', labelIds: ['INBOX', 'UNREAD'] }),
			makeThread({ id: 'b', snippet: 'cached-b' }),
			makeThread({ id: 'c', snippet: 'cached-c' })
		];

		/* Step 2: Background refresh returns page 1 with updates. */
		const refreshed = [
			makeThread({ id: 'new1', snippet: 'brand-new' }),
			makeThread({ id: 'a', snippet: 'refreshed-a', labelIds: ['INBOX'] }) /* read now */
		];
		list = mergeThreads(list, refreshed, 'refresh');

		expect(list.length).toBe(4); /* 1 new + 3 existing */
		expect(list[0].id).toBe('new1'); /* new thread prepended */
		expect(list.find((t) => t.id === 'a')!.labelIds).toEqual(['INBOX']); /* updated */
		expect(list.find((t) => t.id === 'c')!.snippet).toBe('cached-c'); /* untouched */

		/* Step 3: Auto-fill appends page 2. */
		const page2 = [
			makeThread({ id: 'd', snippet: 'page2-d' }),
			makeThread({ id: 'a', snippet: 'should-not-update' }) /* duplicate, ignored */
		];
		list = mergeThreads(list, page2, 'append');

		expect(list.length).toBe(5); /* 'd' added, 'a' duplicate ignored */
		expect(list[list.length - 1].id).toBe('d');
		expect(list.find((t) => t.id === 'a')!.snippet).toBe('refreshed-a'); /* not overwritten */
	});

	it('thread with same ID but completely different data is replaced in refresh', () => {
		const existing = [
			makeThread({
				id: 'x',
				subject: 'Old',
				from: { name: 'Alice', email: 'alice@test.com' },
				to: 'bob@test.com',
				date: '2025-01-01T00:00:00Z',
				snippet: 'old snippet',
				labelIds: ['INBOX', 'UNREAD'],
				messageCount: 1
			})
		];

		const server = [
			makeThread({
				id: 'x',
				subject: 'New Subject',
				from: { name: 'Alice Updated', email: 'alice@test.com' },
				to: 'charlie@test.com',
				date: '2026-02-12T10:00:00Z',
				snippet: 'completely new snippet',
				labelIds: ['INBOX', 'STARRED'],
				messageCount: 5
			})
		];

		const result = mergeThreads(existing, server, 'refresh');

		expect(result.length).toBe(1);
		expect(result[0].subject).toBe('New Subject');
		expect(result[0].from.name).toBe('Alice Updated');
		expect(result[0].to).toBe('charlie@test.com');
		expect(result[0].date).toBe('2026-02-12T10:00:00Z');
		expect(result[0].snippet).toBe('completely new snippet');
		expect(result[0].labelIds).toEqual(['INBOX', 'STARRED']);
		expect(result[0].messageCount).toBe(5);
	});
});
