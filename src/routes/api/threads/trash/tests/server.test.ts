/**
 * @fileoverview Integration tests for POST /api/threads/trash.
 *
 * Tests cover:
 *   - CSRF validation (missing header, missing cookie, mismatch) → 403
 *   - Successful batch trash → 200 with per-thread results
 *   - Request body validation (missing/empty/too-many threadIds, invalid JSON)
 *   - Not authenticated → 401
 *   - Token refresh failure → 401
 *   - Gmail API failure → 500
 *   - Gmail auth error (401/invalid_grant) → 401
 *   - Session expired (non-"Not authenticated" getAccessToken errors) → 401
 *   - Non-Error thrown by getAccessToken → 401 "Unknown error"
 *   - Gmail batch invalid_grant → 401
 *   - Non-Error thrown by batchTrashThreads → 500 "Unknown error"
 *   - Whitespace-only threadIds, non-string elements, string instead of array → 400
 *   - Null body → 400
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

/* Mock auth and gmail modules before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	getAccessToken: vi.fn(),
	validateCsrf: vi.fn()
}));

vi.mock('$lib/server/gmail.js', () => ({
	batchTrashThreads: vi.fn()
}));

import { POST } from '../+server.js';
import { getAccessToken, validateCsrf } from '$lib/server/auth.js';
import { batchTrashThreads } from '$lib/server/gmail.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for POST /api/threads/trash.
 *
 * @param body - The JSON body to include in the request.
 * @param options - Additional options.
 * @param options.invalidJson - If true, simulates a non-JSON body.
 * @param options.csrfHeader - Value for the x-csrf-token header (omit to not set).
 */
function createMockEvent(
	body?: unknown,
	options: { invalidJson?: boolean; csrfHeader?: string } = {}
) {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (options.csrfHeader !== undefined) {
		headers.set('x-csrf-token', options.csrfHeader);
	}

	return {
		cookies: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			serialize: vi.fn(),
			getAll: vi.fn()
		},
		request: {
			json: options.invalidJson
				? vi.fn().mockRejectedValue(new SyntaxError('Unexpected token'))
				: vi.fn().mockResolvedValue(body),
			headers
		}
	};
}

// =============================================================================
// Tests
// =============================================================================

describe('POST /api/threads/trash', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── CSRF Validation ────────────────────────────────────────────────

	it('returns 403 when CSRF validation fails', async () => {
		vi.mocked(validateCsrf).mockReturnValue(false);

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 403)).toBe(true);
			if (isHttpError(err, 403)) expect(err.body.message).toContain('CSRF validation failed');
		}
	});

	it('checks CSRF before parsing request body', async () => {
		/*
		 * Security invariant: CSRF must be validated before any request
		 * body parsing. If CSRF fails, getAccessToken and batchTrashThreads
		 * should never be called.
		 */
		vi.mocked(validateCsrf).mockReturnValue(false);

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
		} catch {
			/* Expected to throw 403. */
		}

		expect(getAccessToken).not.toHaveBeenCalled();
		expect(batchTrashThreads).not.toHaveBeenCalled();
		/* request.json() should not be called when CSRF fails. */
		expect(event.request.json).not.toHaveBeenCalled();
	});

	it('proceeds when CSRF validation passes', async () => {
		vi.mocked(validateCsrf).mockReturnValue(true);
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(batchTrashThreads).mockResolvedValue([{ threadId: 't1', success: true }]);

		const event = createMockEvent({ threadIds: ['t1'] });
		const response = await POST(event as any);

		expect(response.status).toBe(200);
		/* validateCsrf receives cookies and request headers. */
		expect(validateCsrf).toHaveBeenCalledWith(event.cookies, event.request.headers);
	});

	// ── Happy Path ─────────────────────────────────────────────────────

	it('returns 200 with per-thread results on success', async () => {
		vi.mocked(validateCsrf).mockReturnValue(true);
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(batchTrashThreads).mockResolvedValue([
			{ threadId: 't1', success: true },
			{ threadId: 't2', success: false, error: 'Thread not found' }
		]);

		const event = createMockEvent({ threadIds: ['t1', 't2'] });
		const response = await POST(event as any);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.results).toHaveLength(2);
		expect(data.results[0]).toEqual({ threadId: 't1', success: true });
		expect(data.results[1]).toEqual({
			threadId: 't2',
			success: false,
			error: 'Thread not found'
		});
		expect(batchTrashThreads).toHaveBeenCalledWith('test-token', ['t1', 't2']);
	});

	// ── Request Validation ─────────────────────────────────────────────

	it('returns 400 for invalid JSON body', async () => {
		vi.mocked(validateCsrf).mockReturnValue(true);
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent(undefined, { invalidJson: true });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Invalid JSON in request body');
		}
	});

	it('returns 400 when threadIds is missing', async () => {
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(batchTrashThreads).mockResolvedValue(
			Array.from({ length: 100 }, (_, i) => ({ threadId: `t${i}`, success: true }))
		);

		const ids = Array.from({ length: 100 }, (_, i) => `t${i}`);
		const event = createMockEvent({ threadIds: ids });
		const response = await POST(event as any);

		expect(response.status).toBe(200);
	});

	// ── Authentication ─────────────────────────────────────────────────

	it('returns 401 when not authenticated', async () => {
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchTrashThreads).mockRejectedValue(
			new Error('Gmail batch request failed (401): Unauthorized')
		);

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
		vi.mocked(validateCsrf).mockReturnValue(true);
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchTrashThreads).mockRejectedValue(
			new Error('Gmail batch request failed (500): Internal Server Error')
		);

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) expect(err.body.message).toContain('Failed to trash threads');
		}
	});

	// ── Session Expired (non-"Not authenticated" auth errors) ──────────

	it('returns 401 "Session expired" when getAccessToken throws a generic error', async () => {
		/*
		 * When getAccessToken throws an error whose message does NOT contain
		 * "Not authenticated" (e.g., decryption failure), the endpoint
		 * should return "Session expired: <message>".
		 */
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
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

	// ── Gmail API: invalid_grant from batch trash ─────────────────────

	it('returns 401 when Gmail batch error message contains invalid_grant', async () => {
		/*
		 * The batch trash call can fail with an invalid_grant error if the
		 * token becomes invalid mid-request. The endpoint checks for
		 * "invalid_grant" in the error message and returns 401.
		 */
		vi.mocked(validateCsrf).mockReturnValue(true);
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchTrashThreads).mockRejectedValue(
			new Error('invalid_grant: Token has been revoked')
		);

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

	it('returns 500 with "Unknown error" when Gmail batch throws a non-Error object', async () => {
		vi.mocked(validateCsrf).mockReturnValue(true);
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchTrashThreads).mockRejectedValue('unexpected-string');

		const event = createMockEvent({ threadIds: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) {
				expect(err.body.message).toContain('Failed to trash threads');
				expect(err.body.message).toContain('Unknown error');
			}
		}
	});

	// ── Request Validation: additional edge cases ─────────────────────

	it('returns 400 when threadIds contains whitespace-only strings', async () => {
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
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
		vi.mocked(validateCsrf).mockReturnValue(true);
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const event = createMockEvent(null);

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
		}
	});
});
