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
	ThreadDetailMessage
} from '../types.js';
import { extractThreadMetadata, extractHeader, parseFrom, parseDate } from './headers.js';
import { sanitizeHtml } from './sanitize.js';

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
 * @returns Thread list items and optional next page token.
 * @throws {Error} If the Gmail API call fails.
 */
export async function listThreads(
	accessToken: string,
	pageToken?: string,
	maxResults: number = 50
): Promise<{ threads: ThreadListItem[]; nextPageToken?: string }> {
	const params = new URLSearchParams({
		maxResults: String(maxResults),
		labelIds: 'INBOX'
	});

	if (pageToken) {
		params.set('pageToken', pageToken);
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
		nextPageToken: data.nextPageToken
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
 *   │   ├── text/plain          ← we want this first
 *   │   └── text/html           ← fallback
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
 *   1. **text/plain** — displayed in a <pre> block, no sanitization needed
 *   2. **text/html** — sanitized server-side to remove scripts/handlers
 *   3. Empty string if no readable body is found (e.g., attachment-only emails)
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
			return { body: sanitizeHtml(decoded), bodyType: 'html' };
		}
		return { body: decoded, bodyType: 'text' };
	}

	/* Try text/plain first (preferred for readability and security). */
	const plainData = findBodyPart(payload, 'text/plain');
	if (plainData) {
		return { body: decodeBase64Url(plainData), bodyType: 'text' };
	}

	/* Fall back to text/html with sanitization. */
	const htmlData = findBodyPart(payload, 'text/html');
	if (htmlData) {
		return { body: sanitizeHtml(decodeBase64Url(htmlData)), bodyType: 'html' };
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

	/* Parse each message into a ThreadDetailMessage. */
	const detailMessages: ThreadDetailMessage[] = messages.map((msg) => {
		const headers = msg.payload?.headers ?? [];
		/* Cast payload to GmailMessagePart — in format=full, mimeType is always present. */
		const { body, bodyType } = extractMessageBody(msg.payload as unknown as GmailMessagePart);

		return {
			id: msg.id,
			from: parseFrom(extractHeader(headers, 'From')),
			to: extractHeader(headers, 'To'),
			subject: extractHeader(headers, 'Subject') || '(no subject)',
			date: parseDate(extractHeader(headers, 'Date')),
			snippet: msg.snippet ?? '',
			body,
			bodyType,
			labelIds: msg.labelIds ?? []
		};
	});

	return {
		id: thread.id,
		subject,
		messages: detailMessages,
		labelIds: [...labelSet]
	};
}
