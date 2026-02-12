/**
 * @fileoverview Integration tests for GET /api/me.
 *
 * Tests cover:
 *   - Successful profile fetch → 200 with { email }
 *   - No refresh cookie → 401 "Not authenticated"
 *   - Token refresh failure → 401 "Session expired"
 *   - Gmail profile fetch failure → 500
 *   - Auth-related Gmail errors → 401
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
});
