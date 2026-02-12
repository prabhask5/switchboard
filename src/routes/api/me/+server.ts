/**
 * @fileoverview Authenticated user profile endpoint.
 *
 * GET /api/me
 *
 * Returns the signed-in user's email address by:
 *   1. Minting a fresh access token from the encrypted refresh-token cookie.
 *   2. Calling Gmail's `users.getProfile` endpoint.
 *
 * Response:
 *   200: { email: string }
 *   401: { error: string }
 *   500: { error: string }
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccessToken, getGmailProfile } from '$lib/server/auth.js';

/**
 * Handles GET /api/me.
 * Returns the user's email if authenticated, or 401 if not.
 */
export const GET: RequestHandler = async ({ cookies }) => {
	/* ── Mint access token from refresh token cookie ──────────────── */
	let accessToken: string;
	try {
		accessToken = await getAccessToken(cookies);
	} catch {
		error(401, 'Not authenticated');
	}

	/* ── Fetch Gmail profile ─────────────────────────────────────── */
	try {
		const profile = await getGmailProfile(accessToken);
		return json({ email: profile.emailAddress });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';

		/* Auth failures should trigger re-login in the UI. */
		if (message.includes('invalid_grant') || message.includes('401')) {
			error(401, 'Session expired. Please sign in again.');
		}

		error(500, `Profile fetch failed: ${message}`);
	}
};
