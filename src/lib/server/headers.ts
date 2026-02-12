/**
 * @fileoverview Gmail message header parsing utilities.
 *
 * Gmail's API returns message headers as an array of { name, value } objects.
 * These utilities extract and parse the headers we care about:
 *   - **Subject**: The thread subject line
 *   - **From**: Sender in "Display Name <email>" format
 *   - **To**: Recipient email(s)
 *   - **Date**: RFC 2822 date string → ISO 8601
 *
 * The parsed results feed into the thread metadata endpoint and the
 * panel rule engine on the client side.
 */

import type { GmailHeader, GmailThread, ParsedFrom, ThreadMetadata } from '../types.js';

// =============================================================================
// Header Extraction
// =============================================================================

/**
 * Extracts a single header value from a Gmail message's header array.
 *
 * Header name matching is case-insensitive per RFC 2822.
 *
 * @param headers - Array of Gmail header objects.
 * @param name - The header name to search for (case-insensitive).
 * @returns The header value, or an empty string if not found.
 */
export function extractHeader(headers: GmailHeader[], name: string): string {
	const lower = name.toLowerCase();
	const header = headers.find((h) => h.name.toLowerCase() === lower);
	return header?.value ?? '';
}

// =============================================================================
// From Header Parsing
// =============================================================================

/**
 * Regex to match "Display Name <email@example.com>" format.
 *
 * Captures:
 *   Group 1: Display name (may include surrounding quotes)
 *   Group 2: Email address inside angle brackets
 */
const FROM_WITH_NAME_REGEX = /^"?([^"<]*)"?\s*<([^>]+)>$/;

/**
 * Parses a "From" header into a display name and email address.
 *
 * Handles common formats:
 *   - `"John Doe <john@example.com>"` → `{ name: "John Doe", email: "john@example.com" }`
 *   - `"john@example.com"`            → `{ name: "", email: "john@example.com" }`
 *   - `"<john@example.com>"`          → `{ name: "", email: "john@example.com" }`
 *   - `""`                            → `{ name: "", email: "" }`
 *
 * @param fromHeader - The raw "From" header value.
 * @returns Parsed name and email.
 */
export function parseFrom(fromHeader: string): ParsedFrom {
	if (!fromHeader) {
		return { name: '', email: '' };
	}

	const trimmed = fromHeader.trim();

	/* Try "Display Name <email>" format first. */
	const match = trimmed.match(FROM_WITH_NAME_REGEX);
	if (match) {
		return {
			name: (match[1] ?? '').trim(),
			email: (match[2] ?? '').trim()
		};
	}

	/* Check for bare "<email>" format. */
	if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
		return { name: '', email: trimmed.slice(1, -1).trim() };
	}

	/* Bare email address or unparseable — treat the whole thing as email. */
	return { name: '', email: trimmed };
}

// =============================================================================
// Date Parsing
// =============================================================================

/**
 * Parses an email date string into an ISO 8601 string.
 *
 * Gmail returns dates in RFC 2822 format (e.g., "Mon, 1 Jan 2024 12:00:00 +0000").
 * We convert to ISO 8601 for consistent client-side formatting.
 *
 * Falls back to the original string if parsing fails (e.g., malformed dates
 * from some mailing list software).
 *
 * @param dateHeader - The raw "Date" header value.
 * @returns ISO 8601 date string, or the original string if unparseable.
 */
export function parseDate(dateHeader: string): string {
	if (!dateHeader) return '';
	const parsed = new Date(dateHeader);
	return isNaN(parsed.getTime()) ? dateHeader : parsed.toISOString();
}

// =============================================================================
// Thread Metadata Extraction
// =============================================================================

/**
 * Extracts structured metadata from a full Gmail thread object.
 *
 * Uses the **first message** for Subject/From/To (thread origin) and
 * the **last message** for Date (most recent activity) and snippet.
 * Label IDs are merged from all messages (union of all labels).
 *
 * @param thread - A Gmail thread in metadata format (from `threads.get`).
 * @returns Structured thread metadata for the inbox UI.
 */
export function extractThreadMetadata(thread: GmailThread): ThreadMetadata {
	const messages = thread.messages ?? [];
	const first = messages[0];
	const last = messages[messages.length - 1];

	/* Extract headers from the first message (thread origin). */
	const firstHeaders = first?.payload?.headers ?? [];
	const subject = extractHeader(firstHeaders, 'Subject') || '(no subject)';
	const from = parseFrom(extractHeader(firstHeaders, 'From'));
	const to = extractHeader(firstHeaders, 'To');

	/* Use the last message for date and snippet (most recent activity). */
	const lastHeaders = last?.payload?.headers ?? [];
	const date = parseDate(extractHeader(lastHeaders, 'Date'));
	const snippet = last?.snippet ?? first?.snippet ?? '';

	/* Merge label IDs from all messages (union). */
	const labelSet = new Set<string>();
	for (const msg of messages) {
		for (const label of msg.labelIds ?? []) {
			labelSet.add(label);
		}
	}

	return {
		id: thread.id,
		subject,
		from,
		to,
		date,
		snippet,
		labelIds: [...labelSet],
		messageCount: messages.length
	};
}
