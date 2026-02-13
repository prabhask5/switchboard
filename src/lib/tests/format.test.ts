/**
 * @fileoverview Unit tests for display formatting utilities.
 *
 * Tests cover:
 *   - HTML entity decoding (named, decimal, hex, mixed, edge cases)
 *   - Inbox list date formatting (today, this year, older, edge cases)
 *   - Thread detail date formatting (absolute + relative time)
 *   - Relative time calculation (all time units, singular/plural, boundaries)
 */

import { describe, it, expect } from 'vitest';
import {
	decodeHtmlEntities,
	formatListDate,
	formatDetailDate,
	formatRelativeTime
} from '../format.js';

// =============================================================================
// HTML Entity Decoding
// =============================================================================

describe('decodeHtmlEntities', () => {
	it('decodes &#39; (decimal apostrophe) to single quote', () => {
		expect(decodeHtmlEntities('We think you&#39;ll love these tips')).toBe(
			"We think you'll love these tips"
		);
	});

	it('decodes &amp; to ampersand', () => {
		expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
	});

	it('decodes &lt; and &gt; to angle brackets', () => {
		expect(decodeHtmlEntities('a &lt; b &gt; c')).toBe('a < b > c');
	});

	it('decodes &quot; to double quote', () => {
		expect(decodeHtmlEntities('She said &quot;hello&quot;')).toBe('She said "hello"');
	});

	it('decodes &apos; to single quote', () => {
		expect(decodeHtmlEntities('it&apos;s fine')).toBe("it's fine");
	});

	it('decodes &nbsp; to regular space', () => {
		expect(decodeHtmlEntities('hello&nbsp;world')).toBe('hello world');
	});

	it('decodes decimal numeric entities', () => {
		/* &#169; = © (copyright symbol) */
		expect(decodeHtmlEntities('&#169; 2026')).toBe('© 2026');
	});

	it('decodes decimal entities without trailing semicolon', () => {
		expect(decodeHtmlEntities('&#39ll')).toBe("'ll");
	});

	it('decodes hex numeric entities (lowercase)', () => {
		/* &#x27; = ' (apostrophe) */
		expect(decodeHtmlEntities('it&#x27;s here')).toBe("it's here");
	});

	it('decodes hex numeric entities (uppercase)', () => {
		/* &#x27; = ' (apostrophe) */
		expect(decodeHtmlEntities('&#x41;BC')).toBe('ABC');
	});

	it('decodes hex entities without trailing semicolon', () => {
		expect(decodeHtmlEntities('&#x27s fine')).toBe("'s fine");
	});

	it('decodes multiple mixed entities in one string', () => {
		expect(decodeHtmlEntities('A &amp; B &#39;s &lt;C&gt; &#x27;D&#x27;')).toBe("A & B 's <C> 'D'");
	});

	it('returns empty string for empty input', () => {
		expect(decodeHtmlEntities('')).toBe('');
	});

	it('returns empty string for null/undefined input', () => {
		expect(decodeHtmlEntities(null as unknown as string)).toBe('');
		expect(decodeHtmlEntities(undefined as unknown as string)).toBe('');
	});

	it('returns original text when no entities are present', () => {
		expect(decodeHtmlEntities('Just plain text')).toBe('Just plain text');
	});

	it('handles real Gmail snippet with multiple entities', () => {
		expect(
			decodeHtmlEntities('Here&#39;s your receipt for $100 &amp; tax. View &lt;details&gt;')
		).toBe("Here's your receipt for $100 & tax. View <details>");
	});

	it('decodes &#039; with leading zero (common Gmail variant)', () => {
		expect(decodeHtmlEntities('it&#039;s')).toBe("it's");
	});

	it('leaves unknown named entities unchanged (e.g., &copy;)', () => {
		/* Only &amp; &lt; &gt; &quot; &apos; &nbsp; are decoded. */
		expect(decodeHtmlEntities('&copy; 2026')).toBe('&copy; 2026');
	});

	it('handles supplementary-plane codepoints correctly via fromCodePoint', () => {
		/*
		 * U+1F600 (grinning face emoji) is codepoint 128512, which is > 0xFFFF.
		 * String.fromCodePoint correctly handles supplementary-plane characters
		 * by producing a surrogate pair.
		 */
		const result = decodeHtmlEntities('&#128512;');
		expect(result).toBe('\u{1F600}');
	});

	it('handles supplementary-plane hex codepoints correctly', () => {
		/* U+1F600 in hex = 0x1F600 */
		const result = decodeHtmlEntities('&#x1F600;');
		expect(result).toBe('\u{1F600}');
	});
});

// =============================================================================
// Inbox List Date Formatting
// =============================================================================

describe('formatListDate', () => {
	/* Use a fixed "now" for all tests: Feb 12, 2026, 10:00 AM UTC */
	const now = new Date('2026-02-12T10:00:00Z');

	it('shows time only for emails from today', () => {
		const result = formatListDate('2026-02-12T15:42:00Z', now);
		/* Should be time-only, e.g. "3:42 PM" (depends on locale/timezone) */
		expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
	});

	it('shows month + day for emails from this year but not today', () => {
		const result = formatListDate('2026-01-15T10:00:00Z', now);
		expect(result).toBe('Jan 15');
	});

	it('shows numeric date with 2-digit year for older emails', () => {
		const result = formatListDate('2024-06-15T10:00:00Z', now);
		expect(result).toBe('6/15/24');
	});

	it('shows month + day for yesterday (not today, but this year)', () => {
		const result = formatListDate('2026-02-11T23:59:00Z', now);
		expect(result).toBe('Feb 11');
	});

	it('shows month + day for a date in this year but not today', () => {
		/* Use midday UTC to avoid timezone-boundary issues. */
		const result = formatListDate('2026-01-15T12:00:00Z', now);
		expect(result).toBe('Jan 15');
	});

	it('shows 2-digit year for last day of previous year', () => {
		const result = formatListDate('2025-12-31T23:59:00Z', now);
		expect(result).toBe('12/31/25');
	});

	it('returns empty string for empty input', () => {
		expect(formatListDate('')).toBe('');
		expect(formatListDate('', now)).toBe('');
	});

	it('returns original string for invalid date', () => {
		expect(formatListDate('not-a-date', now)).toBe('not-a-date');
	});

	it('uses current time when now parameter is omitted', () => {
		/* Just verify it returns a non-empty string and does not throw. */
		const result = formatListDate('2020-01-01T00:00:00Z');
		expect(result).toBeTruthy();
	});
});

// =============================================================================
// Thread Detail Date Formatting
// =============================================================================

describe('formatDetailDate', () => {
	it('shows absolute date with relative time in parentheses', () => {
		const now = new Date('2026-02-12T01:29:00Z');
		const result = formatDetailDate('2026-02-11T23:29:00Z', now);

		/* Should contain both the absolute date and relative time. */
		expect(result).toMatch(/Feb\s+11,\s+2026/);
		expect(result).toContain('(2 hours ago)');
	});

	it('shows "just now" for very recent messages', () => {
		const now = new Date('2026-02-12T10:00:30Z');
		const result = formatDetailDate('2026-02-12T10:00:00Z', now);

		expect(result).toContain('(just now)');
	});

	it('shows minutes ago for recent messages', () => {
		const now = new Date('2026-02-12T10:14:00Z');
		const result = formatDetailDate('2026-02-12T10:00:00Z', now);

		expect(result).toContain('(14 minutes ago)');
	});

	it('shows "1 minute ago" (singular)', () => {
		const now = new Date('2026-02-12T10:01:30Z');
		const result = formatDetailDate('2026-02-12T10:00:30Z', now);

		expect(result).toContain('(1 minute ago)');
	});

	it('shows hours ago', () => {
		const now = new Date('2026-02-12T15:00:00Z');
		const result = formatDetailDate('2026-02-12T10:00:00Z', now);

		expect(result).toContain('(5 hours ago)');
	});

	it('shows days ago', () => {
		const now = new Date('2026-02-15T10:00:00Z');
		const result = formatDetailDate('2026-02-12T10:00:00Z', now);

		expect(result).toContain('(3 days ago)');
	});

	it('shows weeks ago', () => {
		const now = new Date('2026-02-26T10:00:00Z');
		const result = formatDetailDate('2026-02-12T10:00:00Z', now);

		expect(result).toContain('(2 weeks ago)');
	});

	it('shows months ago', () => {
		const now = new Date('2026-05-12T10:00:00Z');
		const result = formatDetailDate('2026-02-12T10:00:00Z', now);

		expect(result).toContain('(2 months ago)');
	});

	it('shows years ago', () => {
		const now = new Date('2027-02-12T10:00:00Z');
		const result = formatDetailDate('2026-02-12T10:00:00Z', now);

		expect(result).toContain('(1 year ago)');
	});

	it('includes the year in the absolute date', () => {
		const now = new Date('2026-02-12T10:00:00Z');
		const result = formatDetailDate('2026-02-12T09:00:00Z', now);

		expect(result).toContain('2026');
	});

	it('returns empty string for empty input', () => {
		expect(formatDetailDate('')).toBe('');
	});

	it('returns original string for invalid date', () => {
		expect(formatDetailDate('not-a-date')).toBe('not-a-date');
	});

	it('uses current time when now parameter is omitted', () => {
		/* Old date should show years ago. */
		const result = formatDetailDate('2020-01-01T00:00:00Z');
		expect(result).toMatch(/year/);
	});
});

// =============================================================================
// Relative Time Calculation
// =============================================================================

describe('formatRelativeTime', () => {
	const base = new Date('2026-02-12T10:00:00Z');

	it('returns "just now" for < 60 seconds', () => {
		const date = new Date('2026-02-12T09:59:30Z');
		expect(formatRelativeTime(date, base)).toBe('just now');
	});

	it('returns "1 minute ago" for exactly 60 seconds', () => {
		const date = new Date('2026-02-12T09:59:00Z');
		expect(formatRelativeTime(date, base)).toBe('1 minute ago');
	});

	it('returns "N minutes ago" (plural) for 2-59 minutes', () => {
		const date = new Date('2026-02-12T09:45:00Z');
		expect(formatRelativeTime(date, base)).toBe('15 minutes ago');
	});

	it('returns "59 minutes ago" at the boundary', () => {
		const date = new Date('2026-02-12T09:01:00Z');
		expect(formatRelativeTime(date, base)).toBe('59 minutes ago');
	});

	it('returns "1 hour ago" for exactly 60 minutes', () => {
		const date = new Date('2026-02-12T09:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('1 hour ago');
	});

	it('returns "N hours ago" (plural) for 2-23 hours', () => {
		const date = new Date('2026-02-12T04:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('6 hours ago');
	});

	it('returns "23 hours ago" at the boundary', () => {
		const date = new Date('2026-02-11T11:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('23 hours ago');
	});

	it('returns "1 day ago" for exactly 24 hours', () => {
		const date = new Date('2026-02-11T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('1 day ago');
	});

	it('returns "N days ago" (plural) for 2-6 days', () => {
		const date = new Date('2026-02-09T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('3 days ago');
	});

	it('returns "1 week ago" for 7-13 days', () => {
		const date = new Date('2026-02-05T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('1 week ago');
	});

	it('returns "N weeks ago" (plural) for 14-29 days', () => {
		const date = new Date('2026-01-29T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('2 weeks ago');
	});

	it('returns "1 month ago" for 30-59 days', () => {
		const date = new Date('2026-01-13T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('1 month ago');
	});

	it('returns "N months ago" (plural) for 60-364 days', () => {
		const date = new Date('2025-12-12T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('2 months ago');
	});

	it('returns "1 year ago" for 365-729 days', () => {
		const date = new Date('2025-02-12T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('1 year ago');
	});

	it('returns "N years ago" (plural) for 730+ days', () => {
		const date = new Date('2023-02-12T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('3 years ago');
	});

	it('returns "just now" for 0 difference', () => {
		expect(formatRelativeTime(base, base)).toBe('just now');
	});

	// ── Boundary Transitions ────────────────────────────────────────

	it('returns "6 days ago" at 6-day boundary (not weeks)', () => {
		/* 6 days = still "days", not "1 week ago". */
		const date = new Date('2026-02-06T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('6 days ago');
	});

	it('transitions from days to weeks at exactly 7 days', () => {
		const date = new Date('2026-02-05T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('1 week ago');
	});

	it('returns "4 weeks ago" at 29-day boundary (not months)', () => {
		/* 29 days = 4 weeks (Math.floor(29/7) = 4), not "1 month ago". */
		const date = new Date('2026-01-14T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('4 weeks ago');
	});

	it('transitions from weeks to months at exactly 30 days', () => {
		const date = new Date('2026-01-13T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('1 month ago');
	});

	it('returns "12 months ago" at 364-day boundary (not years)', () => {
		/* 364 days = 12 months (Math.floor(364/30) = 12), still months not years. */
		const date = new Date('2025-02-13T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('12 months ago');
	});

	it('transitions from months to years at exactly 365 days', () => {
		const date = new Date('2025-02-12T10:00:00Z');
		expect(formatRelativeTime(date, base)).toBe('1 year ago');
	});

	it('returns "just now" for future dates (negative difference)', () => {
		const baseDate = new Date('2026-02-12T10:00:00Z');
		const futureDate = new Date('2026-02-13T10:00:00Z');
		/* All diff values are negative, all > 0 checks fail, falls through to "just now". */
		expect(formatRelativeTime(futureDate, baseDate)).toBe('just now');
	});
});
