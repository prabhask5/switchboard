/**
 * @fileoverview Thread listing endpoint.
 *
 * GET /api/threads?pageToken=...
 *
 * Returns the user's inbox threads (IDs + snippets only). This is the
 * first phase of the two-phase fetch pattern — the client follows up
 * with POST /api/threads/metadata to get full headers.
 *
 * Response:
 *   200: { threads: ThreadListItem[], nextPageToken?: string }
 *   401: { message: string } — not authenticated or session expired
 *   500: { message: string } — Gmail API error
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccessToken } from '$lib/server/auth.js';
import { listThreads } from '$lib/server/gmail.js';

/**
 * Handles GET /api/threads.
 *
 * Mints an access token from the refresh cookie, then calls Gmail's
 * `threads.list` endpoint to fetch inbox thread summaries.
 */
export const GET: RequestHandler = async ({ cookies, url }) => {
	const pageToken = url.searchParams.get('pageToken') ?? undefined;

	/* ── Step 1: Mint access token from refresh token cookie ──────── */
	let accessToken: string;
	try {
		accessToken = await getAccessToken(cookies);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';

		/* "Not authenticated" is expected for unauthenticated visitors (warn, not error). */
		if (message.includes('Not authenticated')) {
			console.warn('[/api/threads] Access token:', message);
			error(401, 'Not authenticated');
		}
		console.error('[/api/threads] Access token error:', message);
		error(401, `Session expired: ${message}`);
	}

	/* ── Step 2: Fetch inbox thread list ──────────────────────────── */
	try {
		const result = await listThreads(accessToken, pageToken);
		return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[/api/threads] Gmail API error:', message);

		/* Auth failures → 401 so the client knows to re-authenticate. */
		if (message.includes('401') || message.includes('invalid_grant')) {
			error(401, 'Session expired. Please sign in again.');
		}

		error(500, `Gmail API error: ${message}`);
	}
};
