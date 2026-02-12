/**
 * @fileoverview Integration tests for GET /auth/google.
 *
 * Tests cover:
 *   - Successful OAuth flow initiation → 302 redirect to Google auth URL
 *   - initiateOAuthFlow is called with the cookies object
 *   - Redirect location matches the auth URL returned by initiateOAuthFlow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

/* Mock the auth module before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	initiateOAuthFlow: vi.fn()
}));

import { GET } from './+server.js';
import { initiateOAuthFlow } from '$lib/server/auth.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for GET /auth/google.
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

describe('GET /auth/google', () => {
	beforeEach(() => {
		/*
		 * resetAllMocks (not clearAllMocks) is needed here because some tests
		 * use mockImplementation to override initiateOAuthFlow behavior.
		 * clearAllMocks only resets call history — resetAllMocks also resets
		 * mock implementations back to the default vi.fn() no-op.
		 */
		vi.resetAllMocks();
	});

	it('calls initiateOAuthFlow with the cookies object', async () => {
		const mockAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test';
		vi.mocked(initiateOAuthFlow).mockReturnValue({ authUrl: mockAuthUrl });

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch {
			/* Redirect is expected; we verify the call was made correctly. */
		}

		expect(initiateOAuthFlow).toHaveBeenCalledOnce();
		expect(initiateOAuthFlow).toHaveBeenCalledWith(event.cookies);
	});

	it('throws a 302 redirect to the auth URL returned by initiateOAuthFlow', async () => {
		const mockAuthUrl =
			'https://accounts.google.com/o/oauth2/v2/auth?client_id=test&scope=gmail&state=abc123';
		vi.mocked(initiateOAuthFlow).mockReturnValue({ authUrl: mockAuthUrl });

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch (err) {
			expect(isRedirect(err)).toBe(true);
			if (isRedirect(err)) {
				expect(err.status).toBe(302);
				expect(err.location).toBe(mockAuthUrl);
			}
		}
	});

	it('propagates errors thrown by initiateOAuthFlow', async () => {
		/*
		 * If initiateOAuthFlow throws (e.g., due to missing env vars),
		 * the error should propagate to the caller without being caught.
		 */
		vi.mocked(initiateOAuthFlow).mockImplementation(() => {
			throw new Error('Missing GOOGLE_CLIENT_ID');
		});

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			/* Should NOT be a redirect — it should be the original error. */
			expect(isRedirect(err)).toBe(false);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe('Missing GOOGLE_CLIENT_ID');
		}
	});

	it('uses the exact authUrl from initiateOAuthFlow without modification', async () => {
		/*
		 * Verify the handler does not append, modify, or encode the URL
		 * returned by initiateOAuthFlow. The URL should pass through
		 * unchanged to the redirect call.
		 */
		const mockAuthUrl =
			'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback&special=a+b%26c';
		vi.mocked(initiateOAuthFlow).mockReturnValue({ authUrl: mockAuthUrl });

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown a redirect');
		} catch (err) {
			expect(isRedirect(err)).toBe(true);
			if (isRedirect(err)) {
				expect(err.location).toBe(mockAuthUrl);
			}
		}
	});
});
