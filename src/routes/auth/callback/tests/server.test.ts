/**
 * @fileoverview Integration tests for GET /auth/callback.
 *
 * Tests cover:
 *   - Successful OAuth callback → 302 redirect to the returned path
 *   - handleOAuthCallback is called with url and cookies
 *   - Error result with status 403 (state mismatch) → throws HttpError 403
 *   - Error result with status 400 (missing code) → throws HttpError 400
 *   - Error result with status 500 (token exchange failure) → throws HttpError 500
 *   - Successful redirect to root path
 *   - Successful redirect to login with error param (user denied consent)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect, isHttpError } from '@sveltejs/kit';

/* Mock the auth module before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	handleOAuthCallback: vi.fn()
}));

import { GET } from '../+server.js';
import { handleOAuthCallback } from '$lib/server/auth.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for GET /auth/callback.
 *
 * The handler uses `url` (for query params) and `cookies` from the event.
 *
 * @param searchParams - Query parameters to include on the callback URL.
 */
function createMockEvent(searchParams: Record<string, string> = {}) {
	const url = new URL('http://localhost:5173/auth/callback');
	for (const [key, value] of Object.entries(searchParams)) {
		url.searchParams.set(key, value);
	}

	return {
		url,
		cookies: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			serialize: vi.fn(),
			getAll: vi.fn()
		}
	};
}

// =============================================================================
// Tests
// =============================================================================

describe('GET /auth/callback', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// =========================================================================
	// Success cases
	// =========================================================================

	it('calls handleOAuthCallback with url and cookies', async () => {
		vi.mocked(handleOAuthCallback).mockResolvedValue({ redirect: '/' });

		const event = createMockEvent({ code: 'auth-code', state: 'abc123' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch {
			/* Redirect is expected. */
		}

		expect(handleOAuthCallback).toHaveBeenCalledOnce();
		expect(handleOAuthCallback).toHaveBeenCalledWith(event.url, event.cookies);
	});

	it('throws a 302 redirect to the path returned by handleOAuthCallback', async () => {
		vi.mocked(handleOAuthCallback).mockResolvedValue({ redirect: '/' });

		const event = createMockEvent({ code: 'auth-code', state: 'abc123' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch (err) {
			expect(isRedirect(err)).toBe(true);
			if (isRedirect(err)) {
				expect(err.status).toBe(302);
				expect(err.location).toBe('/');
			}
		}
	});

	it('redirects to login with error param when user denies consent', async () => {
		/*
		 * When the user denies consent, handleOAuthCallback returns a redirect
		 * to /login?error=access_denied (not an error object).
		 */
		vi.mocked(handleOAuthCallback).mockResolvedValue({
			redirect: '/login?error=access_denied'
		});

		const event = createMockEvent({ error: 'access_denied', state: 'abc123' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch (err) {
			expect(isRedirect(err)).toBe(true);
			if (isRedirect(err)) {
				expect(err.status).toBe(302);
				expect(err.location).toBe('/login?error=access_denied');
			}
		}
	});

	// =========================================================================
	// Error cases – handleOAuthCallback returns { error: ... }
	// =========================================================================

	it('throws HttpError 403 when state mismatch occurs', async () => {
		vi.mocked(handleOAuthCallback).mockResolvedValue({
			error: {
				status: 403,
				message: 'OAuth state mismatch. Please try signing in again.'
			}
		});

		const event = createMockEvent({ code: 'auth-code', state: 'wrong-state' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 403)).toBe(true);
			if (isHttpError(err, 403)) {
				expect(err.body.message).toBe('OAuth state mismatch. Please try signing in again.');
			}
		}
	});

	it('throws HttpError 400 when authorization code is missing', async () => {
		vi.mocked(handleOAuthCallback).mockResolvedValue({
			error: {
				status: 400,
				message: 'Missing authorization code in callback.'
			}
		});

		const event = createMockEvent({ state: 'abc123' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) {
				expect(err.body.message).toBe('Missing authorization code in callback.');
			}
		}
	});

	it('throws HttpError 400 when PKCE verifier cookie is missing', async () => {
		vi.mocked(handleOAuthCallback).mockResolvedValue({
			error: {
				status: 400,
				message: 'Missing PKCE verifier. Please try signing in again.'
			}
		});

		const event = createMockEvent({ code: 'auth-code', state: 'abc123' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) {
				expect(err.body.message).toBe('Missing PKCE verifier. Please try signing in again.');
			}
		}
	});

	it('throws HttpError 500 when token exchange fails', async () => {
		vi.mocked(handleOAuthCallback).mockResolvedValue({
			error: {
				status: 500,
				message: 'Token exchange failed: Token exchange failed (400): invalid_grant'
			}
		});

		const event = createMockEvent({ code: 'bad-code', state: 'abc123' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) {
				expect(err.body.message).toContain('Token exchange failed');
			}
		}
	});

	it('throws HttpError 500 when no refresh token is received', async () => {
		vi.mocked(handleOAuthCallback).mockResolvedValue({
			error: {
				status: 500,
				message:
					'No refresh token received. Please revoke app access in your Google Account settings and try again.'
			}
		});

		const event = createMockEvent({ code: 'auth-code', state: 'abc123' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) {
				expect(err.body.message).toContain('No refresh token received');
			}
		}
	});

	// =========================================================================
	// Edge cases
	// =========================================================================

	it('propagates unexpected errors thrown by handleOAuthCallback', async () => {
		/*
		 * If handleOAuthCallback rejects (throws) instead of returning an
		 * error result object, the error should propagate unmodified.
		 */
		vi.mocked(handleOAuthCallback).mockRejectedValue(new Error('Unexpected internal error'));

		const event = createMockEvent({ code: 'auth-code', state: 'abc123' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isRedirect(err)).toBe(false);
			expect(isHttpError(err)).toBe(false);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe('Unexpected internal error');
		}
	});

	it('handles error result with correct status and message passthrough', async () => {
		/*
		 * The handler should use the exact status and message from the
		 * error result returned by handleOAuthCallback — no transformation.
		 */
		vi.mocked(handleOAuthCallback).mockResolvedValue({
			error: { status: 403, message: 'Custom error message' }
		});

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 403)).toBe(true);
			if (isHttpError(err, 403)) {
				expect(err.body.message).toBe('Custom error message');
			}
		}
	});
});
