/**
 * @fileoverview OAuth 2.0 initiation endpoint.
 *
 * GET /auth/google
 *
 * Starts the OAuth flow by generating PKCE + state, storing them in
 * ephemeral cookies, and redirecting to Google's consent screen.
 * All heavy lifting is delegated to the unified auth module.
 */

import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { initiateOAuthFlow } from '$lib/server/auth.js';

/**
 * Handles GET /auth/google.
 * Generates PKCE + state, sets cookies, redirects to Google.
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const { authUrl } = initiateOAuthFlow(cookies);
	redirect(302, authUrl);
};
