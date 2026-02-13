/**
 * @fileoverview Integration tests for POST /api/threads/metadata.
 *
 * Tests cover:
 *   - Successful batch metadata fetch → 200 with { threads }
 *   - Invalid JSON body → 400
 *   - Empty ids array → 400
 *   - Too many ids (>100) → 400
 *   - Empty string in ids array → 400
 *   - Not authenticated → 401
 *   - Gmail batch error → 500
 *   - Gmail auth error → 401
 *   - Exactly 100 ids (at the limit) → 200
 *   - Session expired (non-"Not authenticated" getAccessToken errors) → 401
 *   - Non-Error thrown by getAccessToken → 401 "Unknown error"
 *   - Gmail batch invalid_grant → 401
 *   - Non-Error thrown by batchGetThreadMetadata → 500 "Unknown error"
 *   - Null body, array body → 400
 *   - Trimming of whitespace in ids
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

/* Mock auth and gmail modules before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	getAccessToken: vi.fn()
}));

vi.mock('$lib/server/gmail.js', () => ({
	batchGetThreadMetadata: vi.fn()
}));

import { POST } from '../+server.js';
import { getAccessToken } from '$lib/server/auth.js';
import { batchGetThreadMetadata } from '$lib/server/gmail.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for POST /api/threads/metadata.
 */
function createMockEvent(body: unknown) {
	return {
		cookies: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			serialize: vi.fn(),
			getAll: vi.fn()
		},
		request: {
			json: vi.fn().mockResolvedValue(body)
		}
	};
}

/**
 * Creates a mock event with a request that throws on .json() (invalid JSON).
 */
function createInvalidJsonEvent() {
	return {
		cookies: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			serialize: vi.fn(),
			getAll: vi.fn()
		},
		request: {
			json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token'))
		}
	};
}

// =============================================================================
// Tests
// =============================================================================

describe('POST /api/threads/metadata', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 200 with thread metadata on success', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		const mockMetadata = [
			{
				id: 't1',
				subject: 'Test',
				from: { name: 'Alice', email: 'alice@example.com' },
				to: 'bob@example.com',
				date: '2024-01-01T12:00:00.000Z',
				snippet: 'Hello',
				labelIds: ['INBOX'],
				messageCount: 1
			}
		];
		vi.mocked(batchGetThreadMetadata).mockResolvedValue(mockMetadata);

		const event = createMockEvent({ ids: ['t1'] });
		const response = await POST(event as any);
		const body = await response.json();

		expect(body.threads).toEqual(mockMetadata);
		expect(batchGetThreadMetadata).toHaveBeenCalledWith('test-token', ['t1']);
	});

	it('returns 400 for invalid JSON body', async () => {
		const event = createInvalidJsonEvent();

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Invalid JSON body');
		}
	});

	it('returns 400 for empty ids array', async () => {
		const event = createMockEvent({ ids: [] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toContain('Invalid request');
		}
	});

	it('returns 400 for missing ids field', async () => {
		const event = createMockEvent({});

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toContain('Invalid request');
		}
	});

	it('returns 400 when ids contains empty strings', async () => {
		const event = createMockEvent({ ids: [''] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toContain('Invalid request');
		}
	});

	it('returns 400 when more than 100 ids are provided', async () => {
		const ids = Array.from({ length: 101 }, (_, i) => `t${i}`);
		const event = createMockEvent({ ids });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toContain('Maximum 100');
		}
	});

	it('returns 401 when not authenticated', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Not authenticated: no refresh token cookie.')
		);

		const event = createMockEvent({ ids: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toBe('Not authenticated');
		}
	});

	it('returns 401 when Gmail returns auth error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchGetThreadMetadata).mockRejectedValue(
			new Error('Gmail batch request failed (401): Unauthorized')
		);

		const event = createMockEvent({ ids: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	it('returns 500 when Gmail returns server error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchGetThreadMetadata).mockRejectedValue(
			new Error('Gmail batch request failed (500): Internal Server Error')
		);

		const event = createMockEvent({ ids: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) expect(err.body.message).toContain('Gmail API error');
		}
	});

	it('accepts exactly 100 ids (at the limit)', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchGetThreadMetadata).mockResolvedValue([]);

		const ids = Array.from({ length: 100 }, (_, i) => `t${i}`);
		const event = createMockEvent({ ids });
		const response = await POST(event as any);
		const body = await response.json();

		expect(body.threads).toEqual([]);
	});

	it('returns 400 when ids contains whitespace-only strings', async () => {
		/*
		 * Zod's z.string().trim().min(1) trims whitespace before checking length,
		 * so "   " becomes "" which fails .min(1) validation. Whitespace-only
		 * thread IDs are never valid for the Gmail API.
		 */
		const event = createMockEvent({ ids: ['   '] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toContain('Invalid request');
		}
	});

	it('returns 400 for ids field with wrong type (string instead of array)', async () => {
		const event = createMockEvent({ ids: 'not-an-array' });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toContain('Invalid request');
		}
	});

	it('returns 400 for ids array containing non-string elements', async () => {
		const event = createMockEvent({ ids: [123, 456] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toContain('Invalid request');
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

		const event = createMockEvent({ ids: ['t1'] });

		try {
			await POST(event as any);
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

		const event = createMockEvent({ ids: ['t1'] });

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

		const event = createMockEvent({ ids: ['t1'] });

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

	// ── Gmail batch: invalid_grant in error message ───────────────────

	it('returns 401 when Gmail batch error message contains invalid_grant', async () => {
		/*
		 * The Gmail batch call can also fail with an invalid_grant error
		 * if the token becomes invalid mid-request. The endpoint checks
		 * for "invalid_grant" in the error message and returns 401.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchGetThreadMetadata).mockRejectedValue(
			new Error('invalid_grant: Token has been revoked')
		);

		const event = createMockEvent({ ids: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	it('returns 500 with "Unknown error" when Gmail batch throws a non-Error object', async () => {
		/*
		 * If batchGetThreadMetadata throws a non-Error value, the endpoint
		 * should use "Unknown error" as the message and return 500.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchGetThreadMetadata).mockRejectedValue('unexpected-string');

		const event = createMockEvent({ ids: ['t1'] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) {
				expect(err.body.message).toContain('Gmail API error');
				expect(err.body.message).toContain('Unknown error');
			}
		}
	});

	// ── Edge cases: request body ──────────────────────────────────────

	it('returns 400 for null body', async () => {
		const event = createMockEvent(null);

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
		}
	});

	it('returns 400 for array body instead of object', async () => {
		const event = createMockEvent(['t1', 't2']);

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
		}
	});

	it('passes trimmed ids to batchGetThreadMetadata', async () => {
		/*
		 * Zod's z.string().trim() should trim whitespace from IDs before
		 * passing them to the Gmail API. Verify that IDs with leading/trailing
		 * whitespace are trimmed.
		 */
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(batchGetThreadMetadata).mockResolvedValue([]);

		const event = createMockEvent({ ids: ['  t1  ', ' t2 '] });
		await POST(event as any);

		expect(batchGetThreadMetadata).toHaveBeenCalledWith('token', ['t1', 't2']);
	});
});
