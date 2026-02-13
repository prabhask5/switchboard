/**
 * @fileoverview Gmail API Client for Email Switchboard.
 *
 * This module wraps the Gmail REST API v1 with:
 *   - **Authenticated fetch**: `gmailFetch()` adds Bearer auth + base URL + timeout.
 *   - **Batch requests**: `gmailBatch()` uses Google's batch endpoint
 *     (multipart/mixed) to fetch multiple threads in a single HTTP call,
 *     minimizing quota usage and round-trips.
 *   - **Thread listing**: `listThreads()` fetches the user's inbox thread IDs.
 *   - **Batch metadata**: `batchGetThreadMetadata()` fetches full headers
 *     for multiple threads at once.
 *
 * Architecture Notes:
 *   - All functions take an `accessToken` parameter rather than cookies,
 *     so they're decoupled from the auth layer and easier to test.
 *   - The batch endpoint has a 100-request limit per call; larger sets
 *     are split into multiple batch calls automatically.
 *   - Error responses from Gmail are parsed and thrown with descriptive
 *     messages for upstream error handling in routes.
 *
 * Two-Phase Fetch Pattern:
 *   1. `listThreads()` → lightweight call returning just IDs + snippets.
 *   2. `batchGetThreadMetadata()` → batch call fetching Subject/From/To/Date
 *      headers for all thread IDs from step 1.
 *   This minimizes API quota usage while getting all data needed for the
 *   inbox list view.
 *
 * @see https://developers.google.com/gmail/api/reference/rest
 * @see https://developers.google.com/gmail/api/guides/batch
 */

import type {
	GmailThread,
	GmailThreadsListResponse,
	GmailMessagePart,
	ThreadListItem,
	ThreadMetadata,
	ThreadDetail,
	ThreadDetailMessage,
	AttachmentInfo,
	TrashResultItem
} from '../types.js';
import { extractThreadMetadata, extractHeader, parseFrom, parseDate } from './headers.js';
import { sanitizeEmailHtml } from './sanitize.js';

// =============================================================================
// Constants
// =============================================================================

/** Gmail API v1 base URL. */
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

/** Google's batch endpoint for Gmail API. */
const BATCH_ENDPOINT = 'https://www.googleapis.com/batch/gmail/v1';

/** Maximum number of requests in a single batch call (Google's limit). */
const BATCH_MAX_SIZE = 100;

/** Default fetch timeout in milliseconds (10 seconds). */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Headers to request when fetching thread metadata.
 * These are the only headers we need for the inbox list view.
 */
const METADATA_HEADERS = ['Subject', 'From', 'To', 'Date'];

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Executes a fetch request with an AbortController timeout.
 *
 * Prevents Gmail API calls from hanging indefinitely if Google's
 * servers are slow or unreachable. The abort signal causes fetch
 * to reject with an AbortError.
 *
 * @param url - The URL to fetch.
 * @param init - Standard fetch options.
 * @param timeoutMs - Timeout in milliseconds (default: 10s).
 * @returns The fetch Response.
 */
async function fetchWithTimeout(
	url: string,
	init: RequestInit = {},
	timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

// =============================================================================
// Authenticated Gmail Fetch
// =============================================================================

/**
 * Makes an authenticated request to the Gmail API.
 *
 * Wraps fetch with:
 *   - Bearer token authorization header
 *   - Gmail API base URL prefix
 *   - AbortController timeout (10s)
 *   - Error response parsing with descriptive messages
 *
 * @param accessToken - Valid Google access token with gmail scope.
 * @param path - API path relative to the Gmail v1 base (e.g., "/users/me/threads").
 * @param init - Additional fetch options (method, body, headers, etc.).
 * @returns The parsed JSON response.
 * @throws {Error} If the request fails or returns a non-OK status.
 */
export async function gmailFetch<T = unknown>(
	accessToken: string,
	path: string,
	init: RequestInit = {}
): Promise<T> {
	const url = `${GMAIL_API_BASE}${path}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		...(init.headers as Record<string, string>)
	};

	const res = await fetchWithTimeout(url, { ...init, headers });

	if (!res.ok) {
		const errorBody = await res.text();
		throw new Error(`Gmail API error (${res.status}) on ${path}: ${errorBody}`);
	}

	return (await res.json()) as T;
}

// =============================================================================
// Batch Requests
// =============================================================================

/**
 * Sends a batch request to the Gmail API.
 *
 * Gmail's batch endpoint accepts up to 100 individual API requests in a
 * single HTTP call using multipart/mixed encoding. This dramatically
 * reduces the number of HTTP round-trips when fetching metadata for
 * many threads.
 *
 * Each individual request in the batch is a GET for a single thread
 * with `format=metadata` and the specific headers we need.
 *
 * If more than 100 thread IDs are provided, they are automatically
 * split into multiple batch requests.
 *
 * @param accessToken - Valid Google access token.
 * @param threadIds - Array of thread IDs to fetch.
 * @returns Array of parsed Gmail thread objects (only successful parts).
 * @throws {Error} If the batch request itself fails (HTTP-level error).
 */
export async function gmailBatch(accessToken: string, threadIds: string[]): Promise<GmailThread[]> {
	if (threadIds.length === 0) return [];

	/* Split into chunks of BATCH_MAX_SIZE if needed. */
	const chunks: string[][] = [];
	for (let i = 0; i < threadIds.length; i += BATCH_MAX_SIZE) {
		chunks.push(threadIds.slice(i, i + BATCH_MAX_SIZE));
	}

	const allThreads: GmailThread[] = [];

	for (const chunk of chunks) {
		const threads = await executeBatchChunk(accessToken, chunk);
		allThreads.push(...threads);
	}

	return allThreads;
}

/**
 * Executes a single batch chunk (up to 100 thread IDs).
 *
 * Constructs the multipart/mixed request body per Google's batch spec,
 * sends it to the batch endpoint, and parses the multipart/mixed response.
 *
 * @param accessToken - Valid Google access token.
 * @param threadIds - Array of thread IDs (max 100).
 * @returns Array of parsed Gmail thread objects from successful parts.
 */
async function executeBatchChunk(accessToken: string, threadIds: string[]): Promise<GmailThread[]> {
	const boundary = `batch_switchboard_${Date.now()}`;

	/* Build the metadata query parameters. */
	const metaParams = METADATA_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join(
		'&'
	);

	/*
	 * Construct each individual request as an HTTP-in-multipart part.
	 * Each part is a complete HTTP request (method + path + headers).
	 */
	const parts = threadIds.map(
		(id) =>
			`--${boundary}\r\n` +
			`Content-Type: application/http\r\n` +
			`Content-Transfer-Encoding: binary\r\n` +
			`\r\n` +
			`GET /gmail/v1/users/me/threads/${id}?format=metadata&${metaParams}\r\n` +
			`\r\n`
	);

	const body = parts.join('') + `--${boundary}--\r\n`;

	const res = await fetchWithTimeout(BATCH_ENDPOINT, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': `multipart/mixed; boundary=${boundary}`
		},
		body
	});

	if (!res.ok) {
		const errorBody = await res.text();
		throw new Error(`Gmail batch request failed (${res.status}): ${errorBody}`);
	}

	/*
	 * Extract boundary from the response Content-Type header.
	 * Google's batch response includes the canonical boundary there
	 * (e.g., "multipart/mixed; boundary=batch_abc123"). The body may
	 * have leading whitespace that breaks first-line parsing.
	 */
	const contentType = res.headers.get('content-type') || '';
	const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
	const responseBoundary = boundaryMatch ? boundaryMatch[1] : undefined;

	/* Parse the multipart/mixed response. */
	const responseText = await res.text();
	return parseBatchResponse(responseText, responseBoundary);
}

/**
 * Parses a multipart/mixed batch response from the Gmail API.
 *
 * The response contains multiple HTTP responses, each separated by a
 * boundary string. Each part has its own HTTP status line, headers,
 * and JSON body.
 *
 * We extract the JSON body from each 200 OK part and skip failed parts
 * (logging a warning for debugging).
 *
 * @param responseText - The raw multipart/mixed response body.
 * @param boundary - Optional boundary string extracted from the Content-Type
 *   response header. When provided, this is used as the part separator
 *   (prefixed with `--`). Falls back to extracting the boundary from the
 *   first line of the response body if not provided.
 * @returns Array of successfully parsed Gmail thread objects.
 */
export function parseBatchResponse(responseText: string, boundary?: string): GmailThread[] {
	const threads: GmailThread[] = [];

	/*
	 * Determine the separator to split parts on.
	 * Prefer the boundary from the Content-Type header (reliable), with
	 * a fallback to first-line extraction for backwards compatibility.
	 */
	let separator: string;
	if (boundary) {
		separator = `--${boundary}`;
	} else {
		/* Fallback: extract the boundary from the first line of the body. */
		const firstNewline = responseText.indexOf('\n');
		const firstLine = (
			firstNewline >= 0 ? responseText.slice(0, firstNewline) : responseText
		).trim();

		if (!firstLine.startsWith('--')) {
			console.error(
				'[gmail] Could not parse batch response boundary. First 200 chars:',
				responseText.slice(0, 200)
			);
			return threads;
		}
		separator = firstLine;
	}

	/* Split by boundary and process each part. */
	const parts = responseText.split(separator);

	for (const part of parts) {
		/* Skip empty parts and the closing boundary. */
		if (!part.trim() || part.trim() === '--') continue;

		/*
		 * Each part contains an HTTP response:
		 *   Content-Type: application/http
		 *   ...
		 *   (blank line)
		 *   HTTP/1.1 200 OK
		 *   Content-Type: application/json
		 *   ...
		 *   (blank line)
		 *   {json body}
		 */
		const jsonMatch = part.match(/\{[\s\S]*\}/);
		if (!jsonMatch) continue;

		/* Check if this part was successful (HTTP 200). */
		if (!part.includes('HTTP/1.1 200') && !part.includes('HTTP/2 200')) {
			console.warn('[gmail] Batch part returned non-200 status, skipping');
			continue;
		}

		try {
			const thread = JSON.parse(jsonMatch[0]) as GmailThread;
			threads.push(thread);
		} catch {
			console.warn('[gmail] Failed to parse batch part JSON');
		}
	}

	return threads;
}

// =============================================================================
// Thread Listing
// =============================================================================

/**
 * Fetches the user's inbox threads (lightweight listing).
 *
 * Calls Gmail's `threads.list` endpoint which returns only thread IDs
 * and snippets — no headers or message content. This is the first
 * call in the two-phase fetch pattern:
 *   1. `listThreads()` → get IDs and snippets
 *   2. `batchGetThreadMetadata()` → get headers for those IDs
 *
 * @param accessToken - Valid Google access token.
 * @param pageToken - Pagination token from a previous response.
 * @param maxResults - Maximum threads per page (default: 50, max: 500).
 * @param q - Optional Gmail search query string. Supports the full Gmail
 *   search syntax: `from:`, `to:`, `subject:`, `has:attachment`, `filename:`,
 *   `before:`, `after:`, `older_than:`, `newer_than:`, `is:unread`, `is:read`,
 *   `is:starred`, `label:`, `category:`, `in:`, `larger:`, `smaller:`, exact
 *   phrases in `""`, `OR`, `-` negation, `()` grouping, `AROUND`. The raw
 *   query string is passed directly to Gmail — all parsing is done server-side.
 *   When provided alongside `labelIds: 'INBOX'`, search results are scoped to
 *   the inbox only.
 * @returns Thread list items, optional next page token, and resultSizeEstimate.
 * @throws {Error} If the Gmail API call fails.
 */
export async function listThreads(
	accessToken: string,
	pageToken?: string,
	maxResults: number = 50,
	q?: string
): Promise<{ threads: ThreadListItem[]; nextPageToken?: string; resultSizeEstimate?: number }> {
	const params = new URLSearchParams({
		maxResults: String(maxResults),
		labelIds: 'INBOX'
	});

	if (pageToken) {
		params.set('pageToken', pageToken);
	}

	/* Append the search query when provided (non-empty). */
	if (q) {
		params.set('q', q);
	}

	const data = await gmailFetch<GmailThreadsListResponse>(
		accessToken,
		`/users/me/threads?${params.toString()}`
	);

	const threads: ThreadListItem[] = (data.threads ?? []).map((t) => ({
		id: t.id,
		snippet: t.snippet
	}));

	return {
		threads,
		nextPageToken: data.nextPageToken,
		resultSizeEstimate: data.resultSizeEstimate
	};
}

// =============================================================================
// Batch Thread Metadata
// =============================================================================

/**
 * Fetches full metadata for multiple threads in a single batch call.
 *
 * This is the second phase of the two-phase fetch pattern. After
 * `listThreads()` returns thread IDs, this function fetches the
 * Subject, From, To, and Date headers for each thread using the
 * Gmail batch endpoint.
 *
 * If more than 100 thread IDs are provided, they are automatically
 * split into multiple batch requests.
 *
 * @param accessToken - Valid Google access token.
 * @param threadIds - Array of thread IDs to fetch metadata for.
 * @returns Array of parsed thread metadata objects.
 * @throws {Error} If the batch request fails.
 */
export async function batchGetThreadMetadata(
	accessToken: string,
	threadIds: string[]
): Promise<ThreadMetadata[]> {
	if (threadIds.length === 0) return [];

	const rawThreads = await gmailBatch(accessToken, threadIds);
	return rawThreads.map(extractThreadMetadata);
}

// =============================================================================
// Attachment Extraction
// =============================================================================

/**
 * Recursively walks the MIME part tree to find all attachment parts.
 *
 * An attachment is identified by having both a non-empty `filename` and a
 * `body.attachmentId`. Inline images (CID-referenced) also have filenames
 * but may lack an attachmentId — those are filtered out.
 *
 * The MIME tree structure varies widely:
 * ```
 * multipart/mixed
 *   ├── multipart/alternative
 *   │   ├── text/plain
 *   │   └── text/html
 *   ├── application/pdf (filename: "report.pdf", attachmentId: "ANGj...")
 *   └── image/png (filename: "photo.png", attachmentId: "BKLm...")
 * ```
 *
 * @param payload - The top-level message payload (or a nested part).
 * @param messageId - The Gmail message ID (included in each AttachmentInfo
 *   so the client can construct the download URL).
 * @returns Array of attachment metadata objects. Empty if no attachments found.
 */
export function extractAttachments(payload: GmailMessagePart, messageId: string): AttachmentInfo[] {
	const attachments: AttachmentInfo[] = [];

	/**
	 * Inner recursive walker. Visits every node in the MIME tree
	 * and collects parts that look like downloadable attachments.
	 */
	function walk(part: GmailMessagePart): void {
		/*
		 * A part is an attachment if it has a filename AND an attachmentId.
		 * Parts with filename but no attachmentId are inline content
		 * (e.g., embedded CID images) — skip those.
		 */
		if (part.filename && part.body?.attachmentId) {
			attachments.push({
				filename: part.filename,
				mimeType: part.mimeType,
				size: part.body.size ?? 0,
				attachmentId: part.body.attachmentId,
				messageId
			});
		}

		/* Recurse into nested parts (multipart containers). */
		if (part.parts) {
			for (const child of part.parts) {
				walk(child);
			}
		}
	}

	walk(payload);
	return attachments;
}

// =============================================================================
// Single Attachment Download
// =============================================================================

/**
 * Raw attachment data returned by Gmail's attachment endpoint.
 *
 * @see https://developers.google.com/gmail/api/reference/rest/v1/users.messages.attachments/get
 */
interface GmailAttachmentResponse {
	/** Base64url-encoded attachment data. */
	data: string;
	/** Size in bytes. */
	size: number;
}

/**
 * Fetches the raw binary data for a single email attachment.
 *
 * Gmail stores large attachment bodies separately from the message payload.
 * When `format=full` is used, attachment parts have a `body.attachmentId`
 * instead of inline `body.data`. This function fetches the actual content
 * via the dedicated attachments endpoint.
 *
 * @param accessToken - Valid Google access token with gmail.modify scope.
 * @param messageId - The Gmail message ID containing the attachment.
 * @param attachmentId - The attachment ID from the MIME part's `body.attachmentId`.
 * @returns The base64url-encoded attachment data string.
 * @throws {Error} If the Gmail API call fails (e.g., 404 for invalid IDs).
 */
export async function getAttachment(
	accessToken: string,
	messageId: string,
	attachmentId: string
): Promise<string> {
	const path =
		`/users/me/messages/${encodeURIComponent(messageId)}` +
		`/attachments/${encodeURIComponent(attachmentId)}`;

	const data = await gmailFetch<GmailAttachmentResponse>(accessToken, path);
	return data.data;
}

// =============================================================================
// Mark as Read
// =============================================================================

/**
 * Marks a single thread as read by removing the UNREAD label.
 *
 * Uses Gmail's `threads.modify` endpoint to remove the UNREAD label
 * from all messages in the thread. This is the same operation Gmail
 * performs when a user opens a thread.
 *
 * @param accessToken - Valid Google access token with gmail.modify scope.
 * @param threadId - The Gmail thread ID to mark as read.
 * @throws {Error} If the Gmail API call fails.
 */
export async function markThreadAsRead(accessToken: string, threadId: string): Promise<void> {
	await gmailFetch(accessToken, `/users/me/threads/${encodeURIComponent(threadId)}/modify`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
	});
}

/**
 * Marks multiple threads as read in parallel.
 *
 * Sends individual `threads.modify` requests for each thread (Gmail doesn't
 * support batch label modifications). Requests are fired concurrently with
 * `Promise.allSettled` so a single failure doesn't abort the entire batch.
 *
 * @param accessToken - Valid Google access token with gmail.modify scope.
 * @param threadIds - Array of Gmail thread IDs to mark as read.
 * @returns Array of results indicating success/failure per thread.
 */
export async function batchMarkAsRead(
	accessToken: string,
	threadIds: string[]
): Promise<Array<{ threadId: string; success: boolean; error?: string }>> {
	if (threadIds.length === 0) return [];

	const results = await Promise.allSettled(
		threadIds.map((id) => markThreadAsRead(accessToken, id))
	);

	return results.map((result, i) => ({
		threadId: threadIds[i],
		success: result.status === 'fulfilled',
		error: result.status === 'rejected' ? String(result.reason) : undefined
	}));
}

// =============================================================================
// Batch Trash
// =============================================================================

/**
 * Moves multiple threads to trash using Gmail's batch endpoint.
 *
 * Each thread is trashed via `POST /gmail/v1/users/me/threads/{id}/trash`
 * bundled into a single multipart/mixed batch request. This is much more
 * efficient than individual trash calls when the user selects multiple
 * threads.
 *
 * If more than 100 thread IDs are provided, they are split into multiple
 * batch calls (Google's batch endpoint limit is 100 per request).
 *
 * @param accessToken - Valid Google access token with gmail.modify scope.
 * @param threadIds - Array of Gmail thread IDs to trash (1–100 recommended).
 * @returns Per-thread results indicating success or failure.
 * @throws {Error} If the batch HTTP request itself fails (not per-thread errors).
 */
export async function batchTrashThreads(
	accessToken: string,
	threadIds: string[]
): Promise<TrashResultItem[]> {
	if (threadIds.length === 0) return [];

	/* Split into chunks of BATCH_MAX_SIZE if needed. */
	const chunks: string[][] = [];
	for (let i = 0; i < threadIds.length; i += BATCH_MAX_SIZE) {
		chunks.push(threadIds.slice(i, i + BATCH_MAX_SIZE));
	}

	const allResults: TrashResultItem[] = [];

	for (const chunk of chunks) {
		const results = await executeTrashBatchChunk(accessToken, chunk);
		allResults.push(...results);
	}

	return allResults;
}

/**
 * Executes a single batch trash chunk (up to 100 thread IDs).
 *
 * Constructs a multipart/mixed batch request where each part is a
 * `POST /gmail/v1/users/me/threads/{id}/trash` request.
 *
 * @param accessToken - Valid Google access token.
 * @param threadIds - Array of thread IDs (max 100).
 * @returns Per-thread trash results.
 */
async function executeTrashBatchChunk(
	accessToken: string,
	threadIds: string[]
): Promise<TrashResultItem[]> {
	const boundary = `batch_trash_${Date.now()}`;

	/*
	 * Each part is a POST request to the thread trash endpoint.
	 * Unlike GET requests in the metadata batch, these are POST with no body
	 * (the trash endpoint doesn't require a request body).
	 */
	const parts = threadIds.map(
		(id) =>
			`--${boundary}\r\n` +
			`Content-Type: application/http\r\n` +
			`Content-Transfer-Encoding: binary\r\n` +
			`\r\n` +
			`POST /gmail/v1/users/me/threads/${id}/trash\r\n` +
			`\r\n`
	);

	const body = parts.join('') + `--${boundary}--\r\n`;

	const res = await fetchWithTimeout(BATCH_ENDPOINT, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': `multipart/mixed; boundary=${boundary}`
		},
		body
	});

	if (!res.ok) {
		const errorBody = await res.text();
		throw new Error(`Gmail batch trash request failed (${res.status}): ${errorBody}`);
	}

	/* Extract boundary from response Content-Type header. */
	const contentType = res.headers.get('content-type') || '';
	const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
	const responseBoundary = boundaryMatch ? boundaryMatch[1] : undefined;

	const responseText = await res.text();
	return parseTrashBatchResponse(responseText, threadIds, responseBoundary);
}

/**
 * Parses a multipart/mixed batch response for trash operations.
 *
 * Each part in the batch response corresponds to a single trash request.
 * Parts are matched to thread IDs by their order in the response (the
 * Gmail batch endpoint preserves request order).
 *
 * HTTP 200 indicates success. Any other status is treated as a failure
 * for that specific thread, with the error message extracted from the
 * response body.
 *
 * @param responseText - The raw multipart/mixed response body from Gmail.
 * @param threadIds - The thread IDs in the same order as the batch request,
 *   used to map response parts back to their thread IDs.
 * @param boundary - Optional boundary string from the Content-Type header.
 *   Falls back to extracting from the response body's first line if not provided.
 * @returns Array of per-thread results with success/failure status.
 */
export function parseTrashBatchResponse(
	responseText: string,
	threadIds: string[],
	boundary?: string
): TrashResultItem[] {
	/*
	 * Determine the separator to split parts on.
	 * Prefer the boundary from the Content-Type header for reliability.
	 */
	let separator: string;
	if (boundary) {
		separator = `--${boundary}`;
	} else {
		const firstNewline = responseText.indexOf('\n');
		const firstLine = (
			firstNewline >= 0 ? responseText.slice(0, firstNewline) : responseText
		).trim();

		if (!firstLine.startsWith('--')) {
			/* Can't parse — treat all threads as failed. */
			return threadIds.map((id) => ({
				threadId: id,
				success: false,
				error: 'Could not parse batch response'
			}));
		}
		separator = firstLine;
	}

	/* Split by boundary and filter out empty/closing parts. */
	const parts = responseText.split(separator).filter((p) => p.trim() && p.trim() !== '--');

	const results: TrashResultItem[] = [];

	for (let i = 0; i < threadIds.length; i++) {
		const part = parts[i];
		if (!part) {
			/* Missing part — treat as failure. */
			results.push({
				threadId: threadIds[i],
				success: false,
				error: 'Missing response part'
			});
			continue;
		}

		/* Check for HTTP 200 status in this part. */
		const isSuccess = part.includes('HTTP/1.1 200') || part.includes('HTTP/2 200');
		if (isSuccess) {
			results.push({ threadId: threadIds[i], success: true });
		} else {
			/* Try to extract an error message from the JSON body. */
			let errorMsg = 'Trash request failed';
			const jsonMatch = part.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				try {
					const parsed = JSON.parse(jsonMatch[0]);
					errorMsg = parsed.error?.message || parsed.error || errorMsg;
				} catch {
					/* JSON parse failed — use default error message. */
				}
			}
			results.push({ threadId: threadIds[i], success: false, error: errorMsg });
		}
	}

	return results;
}

// =============================================================================
// Thread Detail (Full Message Body)
// =============================================================================

/**
 * Decodes a base64url-encoded string to UTF-8 text.
 *
 * Gmail API returns message body content in base64url encoding (RFC 4648 §5),
 * which uses `-` and `_` instead of `+` and `/`, with no padding. This
 * function converts to standard base64 and decodes.
 *
 * @param base64url - The base64url-encoded string from the Gmail API.
 * @returns The decoded UTF-8 string.
 */
export function decodeBase64Url(base64url: string): string {
	/* Convert base64url to standard base64 by replacing URL-safe chars. */
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');

	/* Add padding if needed (base64 requires length divisible by 4). */
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

	/* Decode: Buffer on Node.js. */
	return Buffer.from(padded, 'base64').toString('utf-8');
}

/**
 * Recursively searches the MIME part tree for a part matching the target MIME type.
 *
 * Gmail messages are structured as a MIME tree. For example, a typical email:
 *
 * ```
 * multipart/mixed
 *   ├── multipart/alternative
 *   │   ├── text/plain          ← fallback
 *   │   └── text/html           ← preferred (like Gmail)
 *   └── application/pdf         ← attachment (ignored)
 * ```
 *
 * This function performs a depth-first search to find the first occurrence
 * of the target MIME type.
 *
 * @param part - The MIME part to search (may have nested parts).
 * @param targetMimeType - The MIME type to look for (e.g., "text/plain").
 * @returns The matching part's body data (base64url), or undefined if not found.
 */
export function findBodyPart(part: GmailMessagePart, targetMimeType: string): string | undefined {
	/* Leaf node: check if it matches the target MIME type. */
	if (part.mimeType === targetMimeType && part.body?.data) {
		return part.body.data;
	}

	/* Recurse into nested parts (e.g., multipart/alternative, multipart/mixed). */
	if (part.parts) {
		for (const child of part.parts) {
			const result = findBodyPart(child, targetMimeType);
			if (result) return result;
		}
	}

	return undefined;
}

/**
 * Extracts the readable body from a Gmail message payload.
 *
 * Tries to extract the message body in preference order:
 *   1. **text/html** — sanitized for inline Shadow DOM rendering
 *   2. **text/plain** — displayed in a `<pre>` block, no sanitization needed
 *   3. Empty string if no readable body is found (e.g., attachment-only emails)
 *
 * HTML is preferred (like Gmail) because most modern emails rely on
 * `<style>` blocks, inline CSS, and images for their layout. The client
 * renders sanitized HTML inside a Shadow DOM for CSS isolation.
 *
 * @param payload - The message payload from `threads.get` with `format=full`.
 * @returns An object with the body text and its format type.
 */
export function extractMessageBody(payload: GmailMessagePart): {
	body: string;
	bodyType: 'text' | 'html';
} {
	/*
	 * Simple messages (no parts array): the body is directly on the payload.
	 * This happens for messages with a single MIME type (e.g., plain text only).
	 */
	if (!payload.parts && payload.body?.data) {
		const decoded = decodeBase64Url(payload.body.data);
		if (payload.mimeType === 'text/html') {
			return { body: sanitizeEmailHtml(decoded), bodyType: 'html' };
		}
		return { body: decoded, bodyType: 'text' };
	}

	/* Prefer text/html for rich rendering (like Gmail). */
	const htmlData = findBodyPart(payload, 'text/html');
	if (htmlData) {
		return { body: sanitizeEmailHtml(decodeBase64Url(htmlData)), bodyType: 'html' };
	}

	/* Fall back to text/plain when no HTML is available. */
	const plainData = findBodyPart(payload, 'text/plain');
	if (plainData) {
		return { body: decodeBase64Url(plainData), bodyType: 'text' };
	}

	/* No readable body found (attachment-only email). */
	return { body: '', bodyType: 'text' };
}

/**
 * Fetches a single thread with full message content (format=full).
 *
 * This endpoint is called when the user opens a thread to read it.
 * It fetches ALL messages in the thread with their full body content
 * (headers + text/plain or text/html body).
 *
 * Unlike the metadata endpoint, this returns one thread per API call
 * (no batching) since users typically read one thread at a time.
 *
 * @param accessToken - Valid Google access token.
 * @param threadId - The Gmail thread ID to fetch.
 * @returns Parsed thread detail with all messages and their bodies.
 * @throws {Error} If the Gmail API call fails.
 */
export async function getThreadDetail(
	accessToken: string,
	threadId: string
): Promise<ThreadDetail> {
	const thread = await gmailFetch<GmailThread>(
		accessToken,
		`/users/me/threads/${encodeURIComponent(threadId)}?format=full`
	);

	const messages = thread.messages ?? [];

	/* Extract the subject from the first message. */
	const firstHeaders = messages[0]?.payload?.headers ?? [];
	const subject = extractHeader(firstHeaders, 'Subject') || '(no subject)';

	/* Merge label IDs from all messages. */
	const labelSet = new Set<string>();
	for (const msg of messages) {
		for (const label of msg.labelIds ?? []) {
			labelSet.add(label);
		}
	}

	/* Parse each message into a ThreadDetailMessage (with attachments). */
	const detailMessages: ThreadDetailMessage[] = messages.map((msg) => {
		const headers = msg.payload?.headers ?? [];
		/* Cast payload to GmailMessagePart — in format=full, mimeType is always present. */
		const payloadAsPart = msg.payload as unknown as GmailMessagePart;
		const { body, bodyType } = extractMessageBody(payloadAsPart);

		/* Walk the MIME tree to find downloadable attachments. */
		const attachments = extractAttachments(payloadAsPart, msg.id);

		return {
			id: msg.id,
			from: parseFrom(extractHeader(headers, 'From')),
			to: extractHeader(headers, 'To'),
			subject: extractHeader(headers, 'Subject') || '(no subject)',
			date: parseDate(extractHeader(headers, 'Date')),
			snippet: msg.snippet ?? '',
			body,
			bodyType,
			labelIds: msg.labelIds ?? [],
			attachments
		};
	});

	return {
		id: thread.id,
		subject,
		messages: detailMessages,
		labelIds: [...labelSet]
	};
}

// =============================================================================
// Per-Panel Count Estimates
// =============================================================================

/**
 * Gets estimated thread counts for each panel using Gmail's `resultSizeEstimate`.
 *
 * For each panel, converts its rules to a Gmail search query and calls
 * `threads.list` with `maxResults=1` to get the estimated count without
 * fetching actual thread data. Also queries with `is:unread` appended
 * for unread estimates.
 *
 * Panels with an empty query string (no rules, or middle panels) return
 * `{ total: 0, unread: 0 }` immediately without making API calls.
 *
 * All per-panel queries are executed concurrently via `Promise.all` for
 * minimum latency.
 *
 * @param accessToken - Valid Google access token.
 * @param queries - Array of Gmail search query strings (one per panel).
 * @returns Array of `{ total, unread }` estimates per panel, in the same
 *   order as the input queries.
 */
export async function getEstimatedCounts(
	accessToken: string,
	queries: string[]
): Promise<Array<{ total: number; unread: number }>> {
	const results = await Promise.all(
		queries.map(async (q) => {
			/* Empty query = no rules configured → return zeroes without API calls. */
			if (!q) return { total: 0, unread: 0 };

			const [totalRes, unreadRes] = await Promise.all([
				gmailFetch<GmailThreadsListResponse>(
					accessToken,
					`/users/me/threads?${new URLSearchParams({
						maxResults: '1',
						labelIds: 'INBOX',
						q
					}).toString()}`
				),
				gmailFetch<GmailThreadsListResponse>(
					accessToken,
					`/users/me/threads?${new URLSearchParams({
						maxResults: '1',
						labelIds: 'INBOX',
						q: `${q} is:unread`
					}).toString()}`
				)
			]);

			return {
				total: totalRes.resultSizeEstimate ?? 0,
				unread: unreadRes.resultSizeEstimate ?? 0
			};
		})
	);

	return results;
}
