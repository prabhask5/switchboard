/**
 * @fileoverview Shared TypeScript types for the Email Switchboard application.
 *
 * These types are used by both server-side API routes and client-side
 * Svelte components. Keeping them in a shared module ensures type safety
 * across the full stack.
 *
 * Type categories:
 *   - Gmail API response shapes (raw types from the REST API)
 *   - Transformed domain types (ThreadListItem, ThreadMetadata)
 *   - Panel configuration types (PanelConfig, PanelRule)
 *   - API request/response envelopes
 */

// =============================================================================
// Gmail API Response Types (raw shapes from the REST API)
// =============================================================================

/**
 * A single header name/value pair from a Gmail message payload.
 *
 * @see https://developers.google.com/gmail/api/reference/rest/v1/users.messages#Message
 */
export interface GmailHeader {
	/** Header name (e.g., "Subject", "From", "To", "Date"). */
	name: string;
	/** Header value. */
	value: string;
}

/**
 * The payload portion of a Gmail message (metadata format).
 * When using `format=metadata`, only the headers array is populated.
 */
export interface GmailMessagePayload {
	/** Message headers (only those requested via `metadataHeaders`). */
	headers: GmailHeader[];
}

/**
 * A single Gmail message within a thread (metadata format).
 *
 * When fetched with `format=metadata`, messages include label IDs,
 * snippet, and only the requested headers — no body content.
 */
export interface GmailMessage {
	/** Immutable message ID. */
	id: string;
	/** The thread this message belongs to. */
	threadId: string;
	/** Gmail label IDs (e.g., ["INBOX", "UNREAD", "CATEGORY_SOCIAL"]). */
	labelIds: string[];
	/** Short text preview of the message body. */
	snippet: string;
	/** Message payload containing headers. */
	payload: GmailMessagePayload;
	/** Internal date as epoch milliseconds string. */
	internalDate: string;
}

/**
 * A full Gmail thread (metadata format).
 *
 * Contains all messages in the conversation, each with their own
 * headers and labels. The messages array is ordered chronologically.
 */
export interface GmailThread {
	/** Immutable thread ID. */
	id: string;
	/** History ID for incremental sync (used in later PRs). */
	historyId: string;
	/** All messages in the thread, ordered oldest → newest. */
	messages: GmailMessage[];
}

/**
 * Response shape from Gmail's `threads.list` endpoint.
 *
 * The `threads` array contains only IDs and snippets — no headers.
 * Full metadata must be fetched separately with `threads.get`.
 *
 * @see https://developers.google.com/gmail/api/reference/rest/v1/users.threads/list
 */
export interface GmailThreadsListResponse {
	/** Array of thread summaries (may be undefined if no threads). */
	threads?: Array<{ id: string; snippet: string; historyId: string }>;
	/** Token for fetching the next page of results. */
	nextPageToken?: string;
	/** Estimated total number of results. */
	resultSizeEstimate?: number;
}

// =============================================================================
// Transformed Domain Types
// =============================================================================

/**
 * Lightweight thread summary returned by GET /api/threads.
 *
 * Contains only the data from `threads.list` (id + snippet).
 * No headers or message content — those come from the metadata endpoint.
 */
export interface ThreadListItem {
	/** Gmail thread ID. */
	id: string;
	/** Short text preview of the thread's latest message. */
	snippet: string;
}

/**
 * Parsed "From" header broken into display name and email address.
 *
 * @example
 * // "John Doe <john@example.com>" → { name: "John Doe", email: "john@example.com" }
 * // "john@example.com"            → { name: "", email: "john@example.com" }
 */
export interface ParsedFrom {
	/** Display name (e.g., "John Doe"). Empty string if not present. */
	name: string;
	/** Email address (e.g., "john@example.com"). */
	email: string;
}

/**
 * Full thread metadata returned by POST /api/threads/metadata.
 *
 * Combines data from `threads.get` (metadata format) with parsed headers.
 * This is the shape used by the inbox UI to render thread rows.
 */
export interface ThreadMetadata {
	/** Gmail thread ID. */
	id: string;
	/** Subject line from the first message in the thread. */
	subject: string;
	/** Parsed sender of the first message. */
	from: ParsedFrom;
	/** Recipient email(s) from the first message (raw To header). */
	to: string;
	/** ISO 8601 date string of the latest message in the thread. */
	date: string;
	/** Short text preview of the latest message. */
	snippet: string;
	/** Gmail label IDs merged from all messages (e.g., ["INBOX", "UNREAD"]). */
	labelIds: string[];
	/** Number of messages in the thread. */
	messageCount: number;
}

// =============================================================================
// Panel Configuration Types
// =============================================================================

/**
 * A single filtering rule for a panel.
 *
 * Rules are tested against thread headers to sort threads into panels.
 * Each rule matches a regex pattern against either the From or To header.
 */
export interface PanelRule {
	/** Which header field this rule matches against. */
	field: 'from' | 'to';
	/** Regex pattern string (tested case-insensitively). */
	pattern: string;
	/** Whether matching threads should be accepted or rejected by this panel. */
	action: 'accept' | 'reject';
}

/**
 * Configuration for a single inbox panel.
 *
 * Users define 4 panels with rules that sort incoming threads.
 * Panel configs are stored in localStorage on the client side.
 *
 * @example
 * {
 *   name: "Work",
 *   rules: [
 *     { field: "from", pattern: "@company\\.com$", action: "accept" },
 *     { field: "from", pattern: "newsletter", action: "reject" }
 *   ]
 * }
 */
export interface PanelConfig {
	/** Human-readable panel name (e.g., "Work", "Personal"). */
	name: string;
	/** Ordered list of rules. First matching rule wins. */
	rules: PanelRule[];
}

// =============================================================================
// API Request / Response Envelopes
// =============================================================================

/** Response shape for GET /api/threads. */
export interface ThreadsListApiResponse {
	/** Thread summaries for the current page. */
	threads: ThreadListItem[];
	/** Token for fetching the next page (undefined if no more pages). */
	nextPageToken?: string;
}

/**
 * Request body for POST /api/threads/metadata.
 * @public Consumed by client-side fetch calls and API documentation.
 */
export interface ThreadsMetadataRequest {
	/** Array of thread IDs to fetch metadata for (1–100). */
	ids: string[];
}

/** Response shape for POST /api/threads/metadata. */
export interface ThreadsMetadataApiResponse {
	/** Full metadata for each requested thread. */
	threads: ThreadMetadata[];
}
