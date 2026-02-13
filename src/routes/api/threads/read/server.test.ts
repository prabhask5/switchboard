/**
 * @fileoverview Integration tests for POST /api/threads/read.
 *
 * Tests cover:
 *   - Successful single-thread mark-as-read → 200
 *   - Successful batch mark-as-read → 200
 *   - Request body validation (missing/empty/too-many threadIds, invalid JSON)
 *   - Not authenticated → 401
 *   - Token refresh failure → 401
 *   - Gmail API failure → 500
 *   - Gmail auth error (401/invalid_grant) → 401
 *   - Session expired (non-"Not authenticated" getAccessToken errors) → 401
 *   - Non-Error thrown by getAccessToken → 401 "Unknown error"
 *   - Non-Error thrown by markThreadAsRead/batchMarkAsRead → 500 "Unknown error"
 *   - Whitespace-only threadIds, non-string elements, string instead of array → 400
 *   - Null body → 400
 *   - Single vs batch routing boundary verification
 *   - Single-thread Gmail 401 error → 401
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

/* Mock auth and gmail modules before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	getAccessToken: vi.fn()
}));

vi.mock('$lib/server/gmail.js', () => ({
	markThreadAsRead: vi.fn(),
	batchMarkAsRead: vi.fn()
}));

import { POST } from './+server.js';
import { getAccessToken } from '$lib/server/auth.js';
import { markThreadAsRead, batchMarkAsRead } from '$lib/server/gmail.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for POST /api/threads/read.
 *
 * @param body - The JSON body to include in the request.
 * @param invalidJson - If true, simulates a non-JSON body (request.json() rejects).
 */
function createMockEvent(body?: unknown, invalidJson = false) {
	return {
		cookies: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			serialize: vi.fn(),
			getAll: vi.fn()
		},
		request: {
			json: invalidJson
				? vi.fn().mockRejectedValue(new SyntaxError('Unexpected token'))
				: vi.fn().mockResolvedValue(body),
			headers: new Headers({ 'content-type': 'application/json' })
		}
	};
}

// =============================================================================
// Tests
// =============================================================================

describe('POST /api/threads/read', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── Happy Path ─────────────────────────────────────────────────────

	it('returns 200 with single result for one thread', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(markThreadAsRead).mockResolvedValue(undefined);

		const event = createMockEvent({ threadIds: ['t1'] });
		const response = await POST(event as any);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.results).toEqual([{ threadId: 't1', success: true }]);
		expect(markThreadAsRead).toHaveBeenCalledWith('test-token', 't1');
		/* Should NOT call batch when there's only one thread. */
		expect(batchMarkAsRead).not.toHaveBeenCalled();
	});

	it('returns 200 with batch results for multiple threads', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(batchMarkAsRead).mockResolvedValue([
			{ threadId: 't1', success: true },
			{ threadId: 't2', success: true },
			{ threadId: 't3', success: false, error: 'Not found' }
		]);

		const event = createMockEvent({ threadIds: ['t1', 't2', 't3'] });
		const response = await POST(event as any);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.results).toHaveLength(3);
		expect(data.results[2]).toEqual({ threadId: 't3', success: false, error: 'Not found' });
		expect(batchMarkAsRead).toHaveBeenCalledWith('test-token', ['t1', 't2', 't3']);
		/* Should NOT call single-thread when there are multiple. */
		expect(markThreadAsRead).not.toHaveBeenCalled();
	});

	// ── Request Validation ─────────────────────────────────────────────

	it('returns 400 for invalid JSON body', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent(undefined, true);

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Invalid JSON in request body');
		}
	});

	it('returns 400 when threadIds is missing', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent({});

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
		}
	});

	it('returns 400 when threadIds is empty array', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent({ threadIds: [] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400))
				expect(err.body.message).toBe('At least one thread ID is required');
		}
	});

	it('returns 400 when threadIds contains empty strings', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent({ threadIds: ['t1', ''] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Thread ID cannot be empty');
		}
	});

	it('returns 400 when threadIds exceeds 100 entries', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const ids = Array.from({ length: 101 }, (_, i) => `t${i}`);
		const event = createMockEvent({ threadIds: ids });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400))
				expect(err.body.message).toBe('Maximum 100 thread IDs per request');
		}
	});

	it('accepts exactly 100 thread IDs (boundary)', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(batchMarkAsRead).mockResolvedValue(
			Array.from({ length: 100 }, (_, i) => ({ threadId: `t${i}`, success: true }))
		);

		const ids = Array.from({ length: 100 }, (_, i) => `t${i}`);
		const event = createMockEvent({ threadIds: ids });
		const response = await POST(event as any);

		expect(response.status).toBe(200);
	});

	// ── Authentication ─────────────────────────────────────────────────

	it('returns 401 when not authenticated', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Not authenticated: no refresh token cookie.')
		);

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toBe('Not authenticated');
		}
	});

	it('returns 401 when token refresh fails', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Token refresh failed (400): invalid_grant')
		);

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	// ── Gmail API Errors ───────────────────────────────────────────────

	it('returns 401 when Gmail returns auth error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(markThreadAsRead).mockRejectedValue(new Error('Gmail API error (401): Unauthorized'));

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401))
				expect(err.body.message).toBe('Session expired. Please sign in again.');
		}
	});

	it('returns 500 when Gmail returns non-auth error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(markThreadAsRead).mockRejectedValue(
			new Error('Gmail API error (500): Internal Server Error')
		);

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500))
				expect(err.body.message).toContain('Failed to mark threads as read');
		}
	});

	it('returns 401 when batch Gmail call returns invalid_grant', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchMarkAsRead).mockRejectedValue(new Error('invalid_grant'));

		const event = createMockEvent({ threadIds: ['t1', 't2'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
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

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
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

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) {
				expect(err.body.message).toContain('Session expired');
				expect(err.body.message).toContain('Unknown error');
			}
		}
	});

	// ── Gmail API: non-Error objects from Gmail ───────────────────────

	it('returns 500 with "Unknown error" when single-thread Gmail call throws a non-Error object', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(markThreadAsRead).mockRejectedValue('unexpected-string');

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) {
				expect(err.body.message).toContain('Failed to mark threads as read');
				expect(err.body.message).toContain('Unknown error');
			}
		}
	});

	it('returns 500 with "Unknown error" when batch Gmail call throws a non-Error object', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchMarkAsRead).mockRejectedValue(42);

		const event = createMockEvent({ threadIds: ['t1', 't2'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) {
				expect(err.body.message).toContain('Failed to mark threads as read');
				expect(err.body.message).toContain('Unknown error');
			}
		}
	});

	// ── Request Validation: additional edge cases ─────────────────────

	it('returns 400 when threadIds contains whitespace-only strings', async () => {
		/*
		 * Zod's z.string().trim().min(1) trims whitespace before checking length,
		 * so "   " becomes "" which fails the min(1) validation.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent({ threadIds: ['   '] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Thread ID cannot be empty');
		}
	});

	it('returns 400 when threadIds is a string instead of array', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent({ threadIds: 'not-an-array' });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
		}
	});

	it('returns 400 when threadIds contains non-string elements', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent({ threadIds: [123, 456] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
		}
	});

	it('returns 400 for null body', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent(null);

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
		}
	});

	// ── Single vs Batch routing ──────────────────────────────────────

	it('uses markThreadAsRead for exactly 1 thread and batchMarkAsRead for exactly 2', async () => {
		/*
		 * Verify the single vs. batch routing boundary:
		 * length === 1 → markThreadAsRead, length > 1 → batchMarkAsRead.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(markThreadAsRead).mockResolvedValue(undefined);
		vi.mocked(batchMarkAsRead).mockResolvedValue([
			{ threadId: 't1', success: true },
			{ threadId: 't2', success: true }
		]);

		/* Single thread → direct call. */
		const event1 = createMockEvent({ threadIds: ['t1'] });
		await POST(event1 as any);
		expect(markThreadAsRead).toHaveBeenCalledTimes(1);
		expect(batchMarkAsRead).not.toHaveBeenCalled();

		vi.clearAllMocks();
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(batchMarkAsRead).mockResolvedValue([
			{ threadId: 't1', success: true },
			{ threadId: 't2', success: true }
		]);

		/* Two threads → batch call. */
		const event2 = createMockEvent({ threadIds: ['t1', 't2'] });
		await POST(event2 as any);
		expect(markThreadAsRead).not.toHaveBeenCalled();
		expect(batchMarkAsRead).toHaveBeenCalledTimes(1);
	});

	it('returns 401 when single-thread Gmail call returns 401 error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(markThreadAsRead).mockRejectedValue(new Error('Gmail API error (401): Unauthorized'));

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401))
				expect(err.body.message).toBe('Session expired. Please sign in again.');
		}
	});
});
