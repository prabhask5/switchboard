/**
 * @fileoverview Integration tests for GET /logout.
 *
 * Tests cover:
 *   - Calls logout(cookies) to clear auth cookies
 *   - Returns 302 redirect to /login
 *   - logout is called before the redirect
 *   - Propagates errors thrown by logout
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

/* Mock the auth module before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	logout: vi.fn()
}));

import { GET } from '../+server.js';
import { logout } from '$lib/server/auth.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for GET /logout.
 *
 * Only the `cookies` property is needed since the handler only uses
 * `cookies` from the event object.
 */
function createMockEvent() {
	return {
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

describe('GET /logout', () => {
	beforeEach(() => {
		/*
		 * resetAllMocks (not clearAllMocks) is needed here because some tests
		 * use mockImplementation to override logout behavior (e.g., to throw).
		 * clearAllMocks only resets call history — resetAllMocks also resets
		 * mock implementations back to the default vi.fn() no-op.
		 */
		vi.resetAllMocks();
	});

	it('calls logout with the cookies object', async () => {
		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch {
			/* Redirect is expected. */
		}

		expect(logout).toHaveBeenCalledOnce();
		expect(logout).toHaveBeenCalledWith(event.cookies);
	});

	it('throws a 302 redirect to /login', async () => {
		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch (err) {
			expect(isRedirect(err)).toBe(true);
			if (isRedirect(err)) {
				expect(err.status).toBe(302);
				expect(err.location).toBe('/login');
			}
		}
	});

	it('calls logout before redirecting', async () => {
		/*
		 * Verify that logout() is invoked before the redirect is thrown.
		 * This ensures cookies are cleared before the response is sent.
		 *
		 * We track the call order by checking that logout was called
		 * by the time the redirect is caught.
		 */
		const callOrder: string[] = [];

		vi.mocked(logout).mockImplementation(() => {
			callOrder.push('logout');
		});

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch (err) {
			if (isRedirect(err)) {
				callOrder.push('redirect');
			}
		}

		expect(callOrder).toEqual(['logout', 'redirect']);
	});

	it('propagates errors thrown by logout', async () => {
		/*
		 * If logout throws (e.g., due to an unexpected error in cookie
		 * deletion), the error should propagate without being swallowed.
		 */
		vi.mocked(logout).mockImplementation(() => {
			throw new Error('Cookie deletion failed');
		});

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			/* Should NOT be a redirect — it should be the original error. */
			expect(isRedirect(err)).toBe(false);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe('Cookie deletion failed');
		}
	});

	it('always redirects to /login (not /, /home, etc.)', async () => {
		/*
		 * The logout endpoint should always redirect to /login specifically,
		 * not to the root or any other page. This ensures unauthenticated
		 * users land on the login page after logout.
		 */
		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch (err) {
			expect(isRedirect(err)).toBe(true);
			if (isRedirect(err)) {
				expect(err.location).not.toBe('/');
				expect(err.location).toBe('/login');
			}
		}
	});
});
