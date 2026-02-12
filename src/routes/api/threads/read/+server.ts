/**
 * @fileoverview Mark-as-read endpoint.
 *
 * POST /api/threads/read
 *
 * Marks one or more threads as read by removing the UNREAD label.
 * Accepts an array of thread IDs (1–100) and processes them:
 *   - Single thread: calls markThreadAsRead() directly.
 *   - Multiple threads: calls batchMarkAsRead() for parallel processing.
 *
 * This endpoint is fire-and-forget from the client perspective — the UI
 * optimistically removes the UNREAD label before calling this endpoint.
 * The response confirms what actually succeeded on the server.
 *
 * Request:
 *   POST /api/threads/read
 *   Content-Type: application/json
 *   Body: { threadIds: string[] }  (1–100 IDs)
 *
 * Response:
 *   200: { results: Array<{ threadId: string; success: boolean; error?: string }> }
 *   400: { message: string } — validation error
 *   401: { message: string } — not authenticated
 *   500: { message: string } — server error
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccessToken } from '$lib/server/auth.js';
import { markThreadAsRead, batchMarkAsRead } from '$lib/server/gmail.js';
import { z } from 'zod';

/**
 * Zod schema for the mark-as-read request body.
 *
 * Validates that `threadIds` is a non-empty array of strings
 * with at most 100 entries (matching Gmail's batch limit).
 */
const ReadRequestSchema = z.object({
	threadIds: z
		.array(z.string().trim().min(1, 'Thread ID cannot be empty'))
		.min(1, 'At least one thread ID is required')
		.max(100, 'Maximum 100 thread IDs per request')
});

/**
 * Handles POST /api/threads/read.
 *
 * Validates the request body, mints an access token, and marks the
 * specified threads as read. For a single thread, makes a direct API
 * call; for multiple threads, uses parallel requests.
 */
export const POST: RequestHandler = async ({ cookies, request }) => {
	/* ── Parse and validate request body ────────────────────────────── */
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON in request body');
	}

	const parsed = ReadRequestSchema.safeParse(body);
	if (!parsed.success) {
		const firstError = parsed.error.issues[0]?.message ?? 'Invalid request';
		error(400, firstError);
	}

	const { threadIds } = parsed.data;

	/* ── Mint access token ─────────────────────────────────────────── */
	let accessToken: string;
	try {
		accessToken = await getAccessToken(cookies);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		if (message.includes('Not authenticated')) {
			console.warn('[/api/threads/read] Access token:', message);
			error(401, 'Not authenticated');
		}
		console.error('[/api/threads/read] Access token error:', message);
		error(401, `Session expired: ${message}`);
	}

	/* ── Mark threads as read ──────────────────────────────────────── */
	try {
		if (threadIds.length === 1) {
			/* Single thread: direct API call. */
			await markThreadAsRead(accessToken, threadIds[0]);
			return json({ results: [{ threadId: threadIds[0], success: true }] });
		}

		/* Multiple threads: parallel requests. */
		const results = await batchMarkAsRead(accessToken, threadIds);
		return json({ results });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[/api/threads/read] Gmail API error:', message);

		if (message.includes('401') || message.includes('invalid_grant')) {
			error(401, 'Session expired. Please sign in again.');
		}

		error(500, `Failed to mark threads as read: ${message}`);
	}
};
