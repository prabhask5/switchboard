/**
 * @fileoverview Integration tests for GET /api/me.
 *
 * Tests cover:
 *   - Successful profile fetch → 200 with { email }
 *   - No refresh cookie → 401 "Not authenticated"
 *   - Token refresh failure → 401 "Session expired"
 *   - Gmail profile fetch failure → 500
 *   - Auth-related Gmail errors → 401
 *   - Session expired (non-"Not authenticated" getAccessToken errors) → 401
 *   - Non-Error thrown by getAccessToken → 401 "Unknown error"
 *   - Gmail invalid_grant → 401
 *   - Non-Error thrown by getGmailProfile → 500 "Unknown error"
 *   - Only email field returned (no profile data leakage)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

/* Mock auth module before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	getAccessToken: vi.fn(),
	getGmailProfile: vi.fn()
}));

import { GET } from './+server.js';
import { getAccessToken, getGmailProfile } from '$lib/server/auth.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for GET /api/me.
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

describe('GET /api/me', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 200 with email on success', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-access-token');
		vi.mocked(getGmailProfile).mockResolvedValue({
			emailAddress: 'user@gmail.com',
			messagesTotal: 100,
			threadsTotal: 50,
			historyId: '12345'
		});

		const event = createMockEvent();
		const response = await GET(event as any);
		const body = await response.json();

		expect(body).toEqual({ email: 'user@gmail.com' });
		expect(getAccessToken).toHaveBeenCalledWith(event.cookies);
		expect(getGmailProfile).toHaveBeenCalledWith('test-access-token');
	});

	it('returns 401 when not authenticated (no cookie)', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Not authenticated: no refresh token cookie.')
		);

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toBe('Not authenticated');
		}
	});

	it('returns 401 when token refresh fails', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Token refresh failed (400): {"error":"invalid_grant"}')
		);

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	it('returns 401 when Gmail returns auth error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getGmailProfile).mockRejectedValue(
			new Error('Gmail profile fetch failed (401): Unauthorized')
		);

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	it('returns 500 when Gmail returns non-auth error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getGmailProfile).mockRejectedValue(
			new Error('Gmail profile fetch failed (503): Service Unavailable')
		);

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) expect(err.body.message).toContain('Gmail API error');
		}
	});

	// ── Session Expired (non-"Not authenticated" auth errors) ──────────

	it('returns 401 "Session expired" when getAccessToken throws a generic error', async () => {
		/*
		 * When getAccessToken throws an error whose message does NOT contain
		 * "Not authenticated" (e.g., decryption failure), the endpoint
		 * should return "Session expired: <message>".
		 */
		vi.mocked(getAccessToken).mockRejectedValue(new Error('Decryption failed: bad padding'));

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) {
				expect(err.body.message).toContain('Session expired');
				expect(err.body.message).toContain('Decryption failed');
			}
		}
	});

	it('returns 401 with "Unknown error" when getAccessToken throws a non-Error object', async () => {
		/*
		 * The endpoint checks `err instanceof Error` for the message.
		 * When a non-Error value is thrown, it should use "Unknown error".
		 */
		vi.mocked(getAccessToken).mockRejectedValue('string-error');

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) {
				expect(err.body.message).toContain('Session expired');
				expect(err.body.message).toContain('Unknown error');
			}
		}
	});

	// ── Gmail API: invalid_grant from getGmailProfile ─────────────────

	it('returns 401 when Gmail profile error message contains invalid_grant', async () => {
		/*
		 * The Gmail profile call can fail with an invalid_grant error if
		 * the token becomes invalid. The endpoint checks for "invalid_grant"
		 * in the error message and returns 401.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getGmailProfile).mockRejectedValue(
			new Error('invalid_grant: Token has been revoked')
		);

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401))
				expect(err.body.message).toBe('Session expired. Please sign in again.');
		}
	});

	it('returns 500 with "Unknown error" when Gmail throws a non-Error object', async () => {
		/*
		 * If getGmailProfile throws a non-Error value, the endpoint
		 * should use "Unknown error" and return 500.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getGmailProfile).mockRejectedValue('unexpected-string');

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) {
				expect(err.body.message).toContain('Gmail API error');
				expect(err.body.message).toContain('Unknown error');
			}
		}
	});

	// ── Edge case: only emailAddress from profile ─────────────────────

	it('returns only the email field from the profile response', async () => {
		/*
		 * Verify that the endpoint only returns { email } and does not leak
		 * other profile fields (messagesTotal, threadsTotal, historyId).
		 */
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(getGmailProfile).mockResolvedValue({
			emailAddress: 'user@gmail.com',
			messagesTotal: 999,
			threadsTotal: 500,
			historyId: '99999'
		});

		const event = createMockEvent();
		const response = await GET(event as any);
		const body = await response.json();

		expect(body).toEqual({ email: 'user@gmail.com' });
		expect(body).not.toHaveProperty('messagesTotal');
		expect(body).not.toHaveProperty('threadsTotal');
		expect(body).not.toHaveProperty('historyId');
	});
});
