/**
 * @fileoverview OAuth 2.0 callback endpoint.
 *
 * GET /auth/callback
 *
 * Google redirects the user here after consent. Validates state,
 * exchanges the code for tokens, stores encrypted refresh token,
 * and redirects home. All logic is in the unified auth module.
 */

import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { handleOAuthCallback } from '$lib/server/auth.js';

/**
 * Handles GET /auth/callback.
 * Validates OAuth response, exchanges code, stores tokens, redirects.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const result = await handleOAuthCallback(url, cookies);

	if ('error' in result) {
		error(result.error.status, result.error.message);
	}

	redirect(302, result.redirect);
};
