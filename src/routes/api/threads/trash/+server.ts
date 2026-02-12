/**
 * @fileoverview Batch trash endpoint.
 *
 * POST /api/threads/trash
 *
 * Moves one or more threads to the trash using Gmail's batch endpoint.
 * Protected by CSRF double-submit validation — the client must include
 * the `x-csrf-token` header matching the `sb_csrf` cookie value.
 *
 * Request:
 *   POST /api/threads/trash
 *   Content-Type: application/json
 *   x-csrf-token: <csrf-token>
 *   Body: { threadIds: string[] }  (1–100 IDs)
 *
 * Response:
 *   200: { results: TrashResultItem[] }
 *   400: { message: string } — validation error
 *   401: { message: string } — not authenticated
 *   403: { message: string } — CSRF validation failed
 *   500: { message: string } — server error
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccessToken, validateCsrf } from '$lib/server/auth.js';
import { batchTrashThreads } from '$lib/server/gmail.js';
import { z } from 'zod';

/**
 * Zod schema for the trash request body.
 *
 * Validates that `threadIds` is a non-empty array of non-empty strings
 * with at most 100 entries (matching Gmail's batch limit).
 */
const TrashRequestSchema = z.object({
	threadIds: z
		.array(z.string().trim().min(1, 'Thread ID cannot be empty'))
		.min(1, 'At least one thread ID is required')
		.max(100, 'Maximum 100 thread IDs per request')
});

/**
 * Handles POST /api/threads/trash.
 *
 * Validates CSRF token, parses the request body, mints an access token,
 * and batch-trashes the specified threads. Returns per-thread results
 * so the client can handle partial failures (rollback only failed threads).
 */
export const POST: RequestHandler = async ({ cookies, request }) => {
	/* ── CSRF validation ───────────────────────────────────────────── */
	if (!validateCsrf(cookies, request.headers)) {
		error(403, 'CSRF validation failed. Please refresh the page and try again.');
	}

	/* ── Parse and validate request body ────────────────────────────── */
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON in request body');
	}

	const parsed = TrashRequestSchema.safeParse(body);
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
			console.warn('[/api/threads/trash] Access token:', message);
			error(401, 'Not authenticated');
		}
		console.error('[/api/threads/trash] Access token error:', message);
		error(401, `Session expired: ${message}`);
	}

	/* ── Batch trash threads ───────────────────────────────────────── */
	try {
		const results = await batchTrashThreads(accessToken, threadIds);
		return json({ results });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[/api/threads/trash] Gmail API error:', message);

		if (message.includes('401') || message.includes('invalid_grant')) {
			error(401, 'Session expired. Please sign in again.');
		}

		error(500, `Failed to trash threads: ${message}`);
	}
};
