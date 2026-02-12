/**
 * @fileoverview Integration tests for GET /api/threads.
 *
 * Tests cover:
 *   - Successful thread listing → 200 with threads and nextPageToken
 *   - Pagination with pageToken
 *   - No refresh cookie → 401 "Not authenticated"
 *   - Token refresh failure → 401
 *   - Gmail API failure → 500
 *   - Gmail auth error → 401
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

/* Mock auth and gmail modules before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	getAccessToken: vi.fn()
}));

vi.mock('$lib/server/gmail.js', () => ({
	listThreads: vi.fn()
}));

import { GET } from './+server.js';
import { getAccessToken } from '$lib/server/auth.js';
import { listThreads } from '$lib/server/gmail.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for GET /api/threads.
 */
function createMockEvent(searchParams: Record<string, string> = {}) {
	const url = new URL('http://localhost:5173/api/threads');
	for (const [key, value] of Object.entries(searchParams)) {
		url.searchParams.set(key, value);
	}

	return {
		cookies: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			serialize: vi.fn(),
			getAll: vi.fn()
		},
		url
	};
}

// =============================================================================
// Tests
// =============================================================================

describe('GET /api/threads', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 200 with threads on success', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(listThreads).mockResolvedValue({
			threads: [
				{ id: 't1', snippet: 'Hello' },
				{ id: 't2', snippet: 'World' }
			],
			nextPageToken: 'page2'
		});

		const event = createMockEvent();
		const response = await GET(event as any);
		const body = await response.json();

		expect(body.threads).toHaveLength(2);
		expect(body.nextPageToken).toBe('page2');
		expect(listThreads).toHaveBeenCalledWith('test-token', undefined);
	});

	it('passes pageToken to listThreads when provided', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockResolvedValue({ threads: [] });

		const event = createMockEvent({ pageToken: 'next-page' });
		await GET(event as any);

		expect(listThreads).toHaveBeenCalledWith('token', 'next-page');
	});

	it('returns 401 when not authenticated', async () => {
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

	it('returns 401 when token refresh fails with auth error', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Token refresh failed (400): invalid_grant')
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

	it('returns 401 when Gmail returns 401', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockRejectedValue(new Error('Gmail API error (401): Unauthorized'));

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
		vi.mocked(listThreads).mockRejectedValue(
			new Error('Gmail API error (500): Internal Server Error')
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
