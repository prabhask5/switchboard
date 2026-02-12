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
	ThreadListItem,
	ThreadMetadata
} from '../types.js';
import { extractThreadMetadata } from './headers.js';

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

	/* Parse the multipart/mixed response. */
	const responseText = await res.text();
	return parseBatchResponse(responseText);
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
 * @returns Array of successfully parsed Gmail thread objects.
 */
export function parseBatchResponse(responseText: string): GmailThread[] {
	const threads: GmailThread[] = [];

	/*
	 * Extract the boundary from the first line. The response starts with
	 * "--<boundary>" followed by the parts.
	 */
	const firstNewline = responseText.indexOf('\n');
	const firstLine = (firstNewline >= 0 ? responseText.slice(0, firstNewline) : responseText).trim();

	if (!firstLine.startsWith('--')) {
		console.error('[gmail] Could not parse batch response boundary');
		return threads;
	}

	/* Split by boundary and process each part. */
	const parts = responseText.split(firstLine);

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
