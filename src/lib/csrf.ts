/**
 * @fileoverview Client-side CSRF token helper.
 *
 * Reads the `sb_csrf` cookie value from `document.cookie` so the client
 * can include it in the `x-csrf-token` header for state-changing requests
 * (POST /api/threads/trash, etc.). This implements the "double-submit cookie"
 * CSRF protection pattern.
 *
 * The CSRF cookie is set with `httpOnly: false` specifically so this module
 * can read it. The server validates that the cookie value matches the header
 * value using a timing-safe comparison.
 *
 * @see src/lib/server/auth.ts — validateCsrf()
 */

/** The cookie name for the CSRF double-submit token. */
const CSRF_COOKIE_NAME = 'sb_csrf';

/**
 * Reads the CSRF token from the `sb_csrf` cookie.
 *
 * Parses `document.cookie` to find the CSRF cookie value. Returns null
 * if the cookie is not found (e.g., user not authenticated, or cookie
 * expired).
 *
 * @returns The CSRF token string, or null if not found.
 *
 * @example
 * ```ts
 * const token = getCsrfToken();
 * if (token) {
 *   fetch('/api/threads/trash', {
 *     method: 'POST',
 *     headers: {
 *       'Content-Type': 'application/json',
 *       'x-csrf-token': token
 *     },
 *     body: JSON.stringify({ threadIds: ['t1'] })
 *   });
 * }
 * ```
 */
export function getCsrfToken(): string | null {
	/*
	 * document.cookie returns a semicolon-separated string like:
	 *   "sb_csrf=abc123; other_cookie=xyz"
	 *
	 * We split on "; " (with space) and find our cookie by name prefix.
	 * The cookie value may contain base64url characters (A-Z, a-z, 0-9, -, _).
	 */
	const cookies = document.cookie.split('; ');
	const prefix = `${CSRF_COOKIE_NAME}=`;

	for (const cookie of cookies) {
		if (cookie.startsWith(prefix)) {
			const value = cookie.slice(prefix.length).trim();
			/* Return null for empty/whitespace-only values — they're not valid tokens. */
			return value || null;
		}
	}

	return null;
}
