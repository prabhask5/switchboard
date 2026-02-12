/**
 * @fileoverview Logout endpoint.
 *
 * GET /logout
 *
 * Clears all authentication cookies and redirects to the login page.
 */

import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { logout } from '$lib/server/auth.js';

/**
 * Handles GET /logout.
 * Clears auth cookies and redirects to /login.
 */
export const GET: RequestHandler = async ({ cookies }) => {
	logout(cookies);
	redirect(302, '/login');
};
