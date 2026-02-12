/**
 * @fileoverview Thread detail endpoint.
 *
 * GET /api/thread/[id]
 *
 * Fetches a single thread with full message content (format=full).
 * Returns all messages in the thread with parsed headers and body
 * content (text/plain preferred, sanitized HTML fallback).
 *
 * This endpoint is called when the user opens a thread to read it.
 * The result is cached on the client side (IndexedDB) so subsequent
 * visits load instantly without another API call.
 *
 * Response:
 *   200: { thread: ThreadDetail }
 *   400: { message: string } — invalid thread ID
 *   401: { message: string } — not authenticated or session expired
 *   500: { message: string } — Gmail API error
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccessToken } from '$lib/server/auth.js';
import { getThreadDetail } from '$lib/server/gmail.js';

/**
 * Handles GET /api/thread/[id].
 *
 * Validates the thread ID parameter, mints an access token from the
 * refresh cookie, fetches the full thread from Gmail, and returns
 * the parsed detail with message bodies.
 */
export const GET: RequestHandler = async ({ cookies, params }) => {
	const threadId = params.id;

	/* ── Validate thread ID ─────────────────────────────────────────── */
	if (!threadId || threadId.trim().length === 0) {
		error(400, 'Missing thread ID');
	}

	/* ── Step 1: Mint access token from refresh token cookie ──────── */
	let accessToken: string;
	try {
		accessToken = await getAccessToken(cookies);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';

		/* "Not authenticated" is expected for unauthenticated visitors (warn, not error). */
		if (message.includes('Not authenticated')) {
			console.warn('[/api/thread] Access token:', message);
			error(401, 'Not authenticated');
		}
		console.error('[/api/thread] Access token error:', message);
		error(401, `Session expired: ${message}`);
	}

	/* ── Step 2: Fetch full thread detail ────────────────────────── */
	try {
		const thread = await getThreadDetail(accessToken, threadId);
		return json({ thread });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[/api/thread] Gmail API error:', message);

		/* Auth failures → 401 so the client knows to re-authenticate. */
		if (message.includes('401') || message.includes('invalid_grant')) {
			error(401, 'Session expired. Please sign in again.');
		}

		/* Thread not found → 404. */
		if (message.includes('404')) {
			error(404, 'Thread not found');
		}

		error(500, `Gmail API error: ${message}`);
	}
};
