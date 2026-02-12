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
 *   401: { message: string } — not authenticated or session expired
 *   500: { message: string } — Gmail API error (logged server-side)
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccessToken, getGmailProfile } from '$lib/server/auth.js';

/**
 * Handles GET /api/me.
 * Returns the user's email if authenticated, or 401 if not.
 */
export const GET: RequestHandler = async ({ cookies }) => {
	/* ── Step 1: Mint access token from refresh token cookie ──────── */
	let accessToken: string;
	try {
		accessToken = await getAccessToken(cookies);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		/*
		 * Differentiate between "no cookie" (not logged in) and
		 * "refresh failed" (token revoked / expired).
		 * "Not authenticated" is expected for first-time visitors (warn, not error).
		 */
		if (message.includes('Not authenticated')) {
			console.warn('[/api/me] Access token:', message);
			error(401, 'Not authenticated');
		}
		console.error('[/api/me] Access token error:', message);
		error(401, `Session expired: ${message}`);
	}

	/* ── Step 2: Fetch Gmail profile ─────────────────────────────── */
	try {
		const profile = await getGmailProfile(accessToken);
		return json({ email: profile.emailAddress });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[/api/me] Gmail profile error:', message);

		/* Auth failures (invalid/expired access token) → 401. */
		if (message.includes('invalid_grant') || message.includes('401')) {
			error(401, 'Session expired. Please sign in again.');
		}

		/*
		 * Common 500 causes:
		 *   - Gmail API not enabled in Google Cloud Console
		 *   - Insufficient scopes (user didn't grant gmail.modify)
		 *   - Google API outage
		 * The full error is logged above for server-side debugging.
		 */
		error(500, `Gmail API error: ${message}`);
	}
};
