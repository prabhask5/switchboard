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
 * Body data for a single MIME part of a Gmail message.
 *
 * The `data` field contains the base64url-encoded content of the part.
 * For text/plain or text/html parts, decode this to get the readable body.
 *
 * @see https://developers.google.com/gmail/api/reference/rest/v1/users.messages#MessagePartBody
 */
export interface GmailMessagePartBody {
	/** Size of the body in bytes. */
	size: number;
	/** Base64url-encoded body content. May be empty for multipart containers. */
	data?: string;
}

/**
 * A single MIME part within a Gmail message payload.
 *
 * Gmail messages are structured as a tree of MIME parts. Multipart messages
 * (e.g., multipart/alternative with text/plain + text/html) have nested
 * `parts` arrays. Leaf parts have a `body` with actual content.
 *
 * @see https://developers.google.com/gmail/api/reference/rest/v1/users.messages#MessagePart
 */
export interface GmailMessagePart {
	/** MIME type of this part (e.g., "text/plain", "text/html", "multipart/alternative"). */
	mimeType: string;
	/** Filename if this part is an attachment. */
	filename?: string;
	/** Headers for this part (e.g., Content-Type, Content-Transfer-Encoding). */
	headers?: GmailHeader[];
	/** Body content for leaf parts. Empty for multipart containers. */
	body?: GmailMessagePartBody;
	/** Nested parts for multipart containers (e.g., multipart/alternative). */
	parts?: GmailMessagePart[];
}

/**
 * The payload portion of a Gmail message.
 *
 * When using `format=metadata`, only the headers array is populated.
 * When using `format=full`, includes mimeType, body, and nested parts
 * representing the full MIME structure of the email.
 */
export interface GmailMessagePayload {
	/** Message headers (only those requested via `metadataHeaders` in metadata format). */
	headers: GmailHeader[];
	/** MIME type of the top-level payload (e.g., "multipart/alternative"). Present in full format. */
	mimeType?: string;
	/** Body content for simple (non-multipart) messages. Present in full format. */
	body?: GmailMessagePartBody;
	/** Nested MIME parts for multipart messages. Present in full format. */
	parts?: GmailMessagePart[];
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

// =============================================================================
// Thread Detail Types
// =============================================================================

/**
 * A single message within a thread detail view.
 *
 * Contains parsed headers and the message body in the preferred format
 * (text/html if available for rich rendering, text/plain fallback).
 * Messages are ordered chronologically (oldest first) matching Gmail's API order.
 */
export interface ThreadDetailMessage {
	/** Immutable message ID. */
	id: string;
	/** Parsed sender information. */
	from: ParsedFrom;
	/** Recipient email(s) from the To header. */
	to: string;
	/** Subject line. */
	subject: string;
	/** ISO 8601 date string of this message. */
	date: string;
	/** Short text preview of the message body. */
	snippet: string;
	/**
	 * The message body content.
	 *
	 * Preference order (like Gmail):
	 *   1. Sanitized text/html (rendered in Shadow DOM for CSS isolation)
	 *   2. text/plain fallback (displayed in a `<pre>` block)
	 *   3. Empty string if no readable body is found
	 */
	body: string;
	/**
	 * The format of the body content.
	 *   - "text": body is plain text
	 *   - "html": body is sanitized HTML
	 */
	bodyType: 'text' | 'html';
	/** Gmail label IDs for this message. */
	labelIds: string[];
}

/**
 * Full thread detail returned by GET /api/thread/[id].
 *
 * Contains all messages in the thread with parsed headers and body content.
 * Used by the thread detail view to display the full conversation.
 */
export interface ThreadDetail {
	/** Gmail thread ID. */
	id: string;
	/** Subject line from the first message. */
	subject: string;
	/** All messages in the thread, ordered oldest → newest. */
	messages: ThreadDetailMessage[];
	/** Gmail label IDs merged from all messages. */
	labelIds: string[];
}

/**
 * Response shape for GET /api/thread/[id].
 * @public Used by future typed fetch wrappers
 */
export interface ThreadDetailApiResponse {
	/** The full thread detail. */
	thread: ThreadDetail;
}

// =============================================================================
// Cache Types (client-side IndexedDB)
// =============================================================================

/**
 * Wrapper for cached data with a timestamp for staleness checks.
 *
 * All cached items include a `cachedAt` timestamp (epoch ms) so the
 * app can implement stale-while-revalidate: serve cached data immediately,
 * then refresh in the background when online.
 */
export interface CachedItem<T> {
	/** The cached data payload. */
	data: T;
	/** When this item was cached (Date.now() epoch milliseconds). */
	cachedAt: number;
}
