/**
 * @fileoverview Display Formatting Utilities.
 *
 * Pure functions for converting raw Gmail API values (HTML-encoded snippets,
 * ISO 8601 timestamps) into human-readable display strings that match
 * Gmail's own formatting conventions.
 *
 * Used by both the inbox list page and the thread detail page for consistent
 * date/time and text rendering.
 *
 * All date formatting functions accept an optional `now` parameter for
 * deterministic testing — production callers omit it to use the real clock.
 *
 * @module format
 */

// =============================================================================
// HTML Entity Decoding
// =============================================================================

/**
 * Decodes HTML entities in text back to their literal characters.
 *
 * The Gmail API returns snippets and subjects with HTML-encoded text
 * (e.g., `&#39;` instead of `'`, `&amp;` instead of `&`). This function
 * reverses that encoding for clean display in the UI.
 *
 * Handles three categories of entities:
 *   1. Named entities: `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`
 *   2. Decimal numeric entities: `&#39;`, `&#169;`, etc.
 *   3. Hex numeric entities: `&#x27;`, `&#xA9;`, etc.
 *
 * @param text - HTML-encoded text from the Gmail API.
 * @returns Decoded plain text with entities resolved to characters.
 *
 * @example
 * ```typescript
 * decodeHtmlEntities("We think you&#39;ll love these tips")
 * // → "We think you'll love these tips"
 *
 * decodeHtmlEntities("Tom &amp; Jerry &lt;3")
 * // → "Tom & Jerry <3"
 * ```
 */
export function decodeHtmlEntities(text: string): string {
	if (!text) return '';

	/*
	 * First pass: decode numeric entities (decimal and hex).
	 * These cover any Unicode character, so we handle them generically
	 * before the fixed named-entity replacements.
	 */
	let decoded = text.replace(/&#x([0-9a-f]+);?/gi, (_, hex) =>
		String.fromCodePoint(parseInt(hex, 16))
	);
	decoded = decoded.replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));

	/*
	 * Second pass: decode the most common named entities.
	 * Gmail consistently uses this small subset — a full HTML parser
	 * is unnecessary.
	 */
	decoded = decoded
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, ' ');

	return decoded;
}

// =============================================================================
// Date Formatting — Inbox List
// =============================================================================

/**
 * Formats an ISO 8601 date string for display in the inbox thread list.
 *
 * Follows Gmail's inbox date conventions:
 *   - **Today**: time only (e.g., "3:42 PM")
 *   - **This year**: month + day (e.g., "Jan 15")
 *   - **Older**: short date (e.g., "1/15/24")
 *
 * @param isoDate - ISO 8601 date string (e.g., "2026-02-11T23:29:00.000Z").
 * @param now - Optional "current time" override for deterministic testing.
 * @returns Formatted date string for the thread list row.
 *
 * @example
 * ```typescript
 * // If today is Feb 12, 2026:
 * formatListDate("2026-02-12T15:42:00Z")  // "3:42 PM"
 * formatListDate("2026-01-15T10:00:00Z")  // "Jan 15"
 * formatListDate("2024-01-15T10:00:00Z")  // "1/15/24"
 * ```
 */
export function formatListDate(isoDate: string, now?: Date): string {
	if (!isoDate) return '';

	const date = new Date(isoDate);
	if (isNaN(date.getTime())) return isoDate;

	const ref = now ?? new Date();

	const isToday =
		date.getFullYear() === ref.getFullYear() &&
		date.getMonth() === ref.getMonth() &&
		date.getDate() === ref.getDate();

	if (isToday) {
		return date.toLocaleTimeString('en-US', {
			hour: 'numeric',
			minute: '2-digit',
			hour12: true
		});
	}

	const isThisYear = date.getFullYear() === ref.getFullYear();
	if (isThisYear) {
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	return date.toLocaleDateString('en-US', {
		month: 'numeric',
		day: 'numeric',
		year: '2-digit'
	});
}

// =============================================================================
// Date Formatting — Thread Detail
// =============================================================================

/**
 * Formats an ISO 8601 date string for display in the thread detail view.
 *
 * Follows Gmail's thread detail conventions, showing both an absolute date/time
 * and a relative time suffix in parentheses:
 *
 *   `"Feb 11, 2026, 11:29 PM (2 hours ago)"`
 *
 * The relative time is calculated using {@link formatRelativeTime} and provides
 * at-a-glance context for how recent the message is.
 *
 * @param isoDate - ISO 8601 date string (e.g., "2026-02-11T23:29:00.000Z").
 * @param now - Optional "current time" override for deterministic testing.
 * @returns Formatted string like `"Feb 11, 2026, 11:29 PM (2 hours ago)"`.
 *
 * @example
 * ```typescript
 * // If now is Feb 12, 2026, 1:29 AM:
 * formatDetailDate("2026-02-11T23:29:00Z")
 * // → "Feb 11, 2026, 11:29 PM (2 hours ago)"
 *
 * formatDetailDate("2026-02-12T01:28:00Z")
 * // → "Feb 12, 2026, 1:28 AM (1 minute ago)"
 * ```
 */
export function formatDetailDate(isoDate: string, now?: Date): string {
	if (!isoDate) return '';

	const date = new Date(isoDate);
	if (isNaN(date.getTime())) return isoDate;

	/*
	 * Absolute date portion: "Feb 11, 2026, 11:29 PM"
	 * Uses Intl-backed toLocaleDateString for locale-consistent output.
	 */
	const absolute = date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		hour12: true
	});

	/* Relative time portion: "(2 hours ago)" */
	const relative = formatRelativeTime(date, now ?? new Date());

	return `${absolute} (${relative})`;
}

// =============================================================================
// Relative Time
// =============================================================================

/**
 * Calculates a human-readable relative time string between two dates.
 *
 * Cascades from largest to smallest time unit, returning the first that
 * applies. Uses approximate calculations (30-day months, 365-day years)
 * since exact precision is unnecessary for relative display.
 *
 * | Difference | Output |
 * |---|---|
 * | < 1 minute | "just now" |
 * | 1 minute | "1 minute ago" |
 * | 2-59 minutes | "N minutes ago" |
 * | 1 hour | "1 hour ago" |
 * | 2-23 hours | "N hours ago" |
 * | 1 day | "1 day ago" |
 * | 2-6 days | "N days ago" |
 * | 7-13 days | "1 week ago" |
 * | 14-29 days | "N weeks ago" |
 * | 30-364 days | "N months ago" |
 * | 365+ days | "N years ago" |
 *
 * @param date - The earlier date to measure from.
 * @param now - The reference "current" date.
 * @returns Relative time string (e.g., "2 hours ago", "just now").
 */
export function formatRelativeTime(date: Date, now: Date): string {
	const diffMs = now.getTime() - date.getTime();
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHour = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHour / 24);
	const diffWeek = Math.floor(diffDay / 7);
	const diffMonth = Math.floor(diffDay / 30);
	const diffYear = Math.floor(diffDay / 365);

	/* Cascade from largest to smallest unit — first match wins. */
	if (diffYear > 0) return `${diffYear} year${diffYear > 1 ? 's' : ''} ago`;
	if (diffMonth > 0) return `${diffMonth} month${diffMonth > 1 ? 's' : ''} ago`;
	if (diffWeek > 0) return `${diffWeek} week${diffWeek > 1 ? 's' : ''} ago`;
	if (diffDay > 0) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
	if (diffHour > 0) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
	if (diffMin > 0) return `${diffMin} minute${diffMin > 1 ? 's' : ''} ago`;
	return 'just now';
}
