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
 *   - Session expired (non-"Not authenticated" getAccessToken errors) → 401
 *   - Non-Error thrown by getAccessToken → 401 "Unknown error"
 *   - Gmail invalid_grant → 401
 *   - Non-Error thrown by listThreads → 500 "Unknown error"
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

import { GET } from '../+server.js';
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
		expect(listThreads).toHaveBeenCalledWith('test-token', undefined, 50, undefined);
	});

	it('passes pageToken to listThreads when provided', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockResolvedValue({ threads: [] });

		const event = createMockEvent({ pageToken: 'next-page' });
		await GET(event as any);

		expect(listThreads).toHaveBeenCalledWith('token', 'next-page', 50, undefined);
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

	it('returns 200 with empty threads array when inbox is empty', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockResolvedValue({ threads: [] });

		const event = createMockEvent();
		const response = await GET(event as any);
		const body = await response.json();

		expect(body.threads).toEqual([]);
		expect(body.nextPageToken).toBeUndefined();
	});

	it('passes undefined when pageToken query param is absent', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockResolvedValue({ threads: [] });

		const event = createMockEvent();
		await GET(event as any);

		/*
		 * The handler uses `url.searchParams.get('pageToken') ?? undefined`
		 * to convert null → undefined for the Gmail API call.
		 */
		expect(listThreads).toHaveBeenCalledWith('token', undefined, 50, undefined);
	});

	// ── Session Expired (non-"Not authenticated" auth errors) ──────────

	it('returns 401 "Session expired" when getAccessToken throws a generic error', async () => {
		/*
		 * When getAccessToken throws an error whose message does NOT contain
		 * "Not authenticated" (e.g., decryption failure, network error),
		 * the endpoint should return "Session expired: <message>".
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

	// ── Gmail API: invalid_grant from listThreads ─────────────────────

	it('returns 401 when Gmail error message contains invalid_grant', async () => {
		/*
		 * The Gmail API can return invalid_grant if the token becomes
		 * invalid mid-request. The endpoint checks for "invalid_grant"
		 * in the error message and returns 401.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockRejectedValue(new Error('invalid_grant: Token has been revoked'));

		const event = createMockEvent();

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	it('returns 500 with "Unknown error" when Gmail throws a non-Error object', async () => {
		/*
		 * If listThreads throws a non-Error value, the endpoint
		 * should use "Unknown error" and return 500.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockRejectedValue('unexpected-string');

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

	it('passes q parameter to listThreads when provided', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockResolvedValue({ threads: [] });

		const event = createMockEvent({ q: 'from:alice@example.com' });
		await GET(event as any);

		expect(listThreads).toHaveBeenCalledWith('token', undefined, 50, 'from:alice@example.com');
	});

	it('passes both pageToken and q when both provided', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockResolvedValue({ threads: [] });

		const event = createMockEvent({ pageToken: 'next-page', q: 'subject:meeting' });
		await GET(event as any);

		expect(listThreads).toHaveBeenCalledWith('token', 'next-page', 50, 'subject:meeting');
	});

	it('passes undefined for q when not provided', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockResolvedValue({ threads: [] });

		const event = createMockEvent();
		await GET(event as any);

		expect(listThreads).toHaveBeenCalledWith('token', undefined, 50, undefined);
	});

	it('returns 200 with empty threads array when search has no results', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(listThreads).mockResolvedValue({ threads: [] });

		const event = createMockEvent({ q: 'from:nonexistent@nobody.com' });
		const response = await GET(event as any);
		const body = await response.json();

		expect(body.threads).toEqual([]);
		expect(body.nextPageToken).toBeUndefined();
	});

	it('returns 401 when not authenticated during search', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Not authenticated: no refresh token cookie.')
		);

		const event = createMockEvent({ q: 'from:test@test.com' });

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
		}
	});
});
