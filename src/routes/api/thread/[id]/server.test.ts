/**
 * @fileoverview Integration tests for GET /api/thread/[id].
 *
 * Tests cover:
 *   - Successful thread detail fetch → 200 with { thread }
 *   - Missing thread ID → 400
 *   - Empty thread ID → 400
 *   - Not authenticated → 401
 *   - Token refresh failure → 401
 *   - Gmail thread not found → 404
 *   - Gmail auth error → 401
 *   - Gmail server error → 500
 *   - Session expired (non-"Not authenticated" getAccessToken errors) → 401
 *   - Non-Error thrown by getAccessToken → 401 "Unknown error"
 *   - Gmail invalid_grant → 401
 *   - Non-Error thrown by getThreadDetail → 500 "Unknown error"
 *   - Empty string thread ID → 400
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

/* Mock auth and gmail modules before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	getAccessToken: vi.fn()
}));

vi.mock('$lib/server/gmail.js', () => ({
	getThreadDetail: vi.fn()
}));

import { GET } from './+server.js';
import { getAccessToken } from '$lib/server/auth.js';
import { getThreadDetail } from '$lib/server/gmail.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for GET /api/thread/[id].
 */
function createMockEvent(threadId?: string) {
	return {
		cookies: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			serialize: vi.fn(),
			getAll: vi.fn()
		},
		params: { id: threadId }
	};
}

// =============================================================================
// Tests
// =============================================================================

describe('GET /api/thread/[id]', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 200 with thread detail on success', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		const mockDetail = {
			id: 't1',
			subject: 'Test Thread',
			messages: [
				{
					id: 'm1',
					from: { name: 'Alice', email: 'alice@example.com' },
					to: 'bob@example.com',
					subject: 'Test Thread',
					date: '2024-01-01T12:00:00.000Z',
					snippet: 'Hello',
					body: 'Hello, World!',
					bodyType: 'text' as const,
					labelIds: ['INBOX'],
					attachments: []
				}
			],
			labelIds: ['INBOX']
		};
		vi.mocked(getThreadDetail).mockResolvedValue(mockDetail);

		const event = createMockEvent('t1');
		const response = await GET(event as any);
		const body = await response.json();

		expect(body.thread).toEqual(mockDetail);
		expect(getThreadDetail).toHaveBeenCalledWith('test-token', 't1');
	});

	it('returns 400 for missing thread ID', async () => {
		const event = createMockEvent(undefined);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Missing thread ID');
		}
	});

	it('returns 400 for empty/whitespace thread ID', async () => {
		const event = createMockEvent('   ');

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Missing thread ID');
		}
	});

	it('returns 401 when not authenticated', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Not authenticated: no refresh token cookie.')
		);

		const event = createMockEvent('t1');

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toBe('Not authenticated');
		}
	});

	it('returns 404 when thread is not found', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getThreadDetail).mockRejectedValue(
			new Error('Gmail API error (404): Thread not found')
		);

		const event = createMockEvent('nonexistent');

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 404)).toBe(true);
			if (isHttpError(err, 404)) expect(err.body.message).toBe('Thread not found');
		}
	});

	it('returns 401 when Gmail returns auth error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('expired-token');
		vi.mocked(getThreadDetail).mockRejectedValue(new Error('Gmail API error (401): Unauthorized'));

		const event = createMockEvent('t1');

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	it('returns 500 when Gmail returns server error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getThreadDetail).mockRejectedValue(
			new Error('Gmail API error (500): Internal Server Error')
		);

		const event = createMockEvent('t1');

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) expect(err.body.message).toContain('Gmail API error');
		}
	});

	// ── Session Expired (non-"Not authenticated" auth errors) ──────────

	it('returns 401 "Session expired" when getAccessToken throws non-auth error (e.g., invalid_grant)', async () => {
		/*
		 * When getAccessToken throws an error whose message does NOT include
		 * "Not authenticated" (e.g., a token refresh failure like invalid_grant),
		 * the endpoint should fall through to the else branch and return
		 * "Session expired: <message>" with a 401 status.
		 */
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Token refresh failed (400): invalid_grant')
		);

		const event = createMockEvent('t1');

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) {
				expect(err.body.message).toContain('Session expired');
				expect(err.body.message).toContain('invalid_grant');
			}
		}
	});

	it('returns 401 "Session expired" when getAccessToken throws a generic error', async () => {
		/*
		 * Any non-"Not authenticated" error from getAccessToken should
		 * result in "Session expired: <message>".
		 */
		vi.mocked(getAccessToken).mockRejectedValue(new Error('Decryption failed: bad padding'));

		const event = createMockEvent('t1');

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

		const event = createMockEvent('t1');

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

	// ── Gmail API: invalid_grant from getThreadDetail ─────────────────

	it('returns 401 when Gmail error message contains invalid_grant', async () => {
		/*
		 * The Gmail API call can fail with an invalid_grant error if the
		 * token becomes invalid. The endpoint checks for "invalid_grant"
		 * in the error message and returns 401.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getThreadDetail).mockRejectedValue(
			new Error('invalid_grant: Token has been revoked')
		);

		const event = createMockEvent('t1');

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
		 * If getThreadDetail throws a non-Error value, the endpoint
		 * should use "Unknown error" and return 500.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getThreadDetail).mockRejectedValue('unexpected-string');

		const event = createMockEvent('t1');

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

	// ── Edge case: empty string thread ID ─────────────────────────────

	it('returns 400 for empty string thread ID (not just whitespace)', async () => {
		const event = createMockEvent('');

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Missing thread ID');
		}
	});
});
