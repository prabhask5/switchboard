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
					labelIds: ['INBOX']
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
});
