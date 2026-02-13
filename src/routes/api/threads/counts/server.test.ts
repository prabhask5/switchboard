/**
 * @fileoverview Integration tests for POST /api/threads/counts.
 *
 * Tests cover:
 *   - Successful count estimation → 200 with per-panel counts
 *   - Missing panels → 400
 *   - Not authenticated → 401
 *   - Gmail API failure → 500
 *   - Gmail auth error → 401
 *   - Catch-all panel handling (last panel with no rules)
 *   - Middle panel with no rules → always {total:0, unread:0}
 *   - Invalid JSON body → 400
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

/* Mock auth, gmail, and rules modules before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	getAccessToken: vi.fn()
}));

vi.mock('$lib/server/gmail.js', () => ({
	getEstimatedCounts: vi.fn()
}));

vi.mock('$lib/rules.js', () => ({
	panelRulesToGmailQuery: vi.fn()
}));

import { POST } from './+server.js';
import { getAccessToken } from '$lib/server/auth.js';
import { getEstimatedCounts } from '$lib/server/gmail.js';
import { panelRulesToGmailQuery } from '$lib/rules.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for POST /api/threads/counts.
 *
 * @param body - The request body to send (will be JSON-serialized).
 */
function createMockEvent(body?: unknown) {
	return {
		cookies: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			serialize: vi.fn(),
			getAll: vi.fn()
		},
		request: {
			json:
				body !== undefined
					? vi.fn().mockResolvedValue(body)
					: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token'))
		}
	};
}

// =============================================================================
// Tests
// =============================================================================

describe('POST /api/threads/counts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 200 with counts array on success', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery)
			.mockReturnValueOnce('from:(@company.com)')
			.mockReturnValueOnce('');
		vi.mocked(getEstimatedCounts).mockResolvedValue([
			{ total: 150, unread: 30 },
			{ total: 0, unread: 0 }
		]);

		const panels = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }] },
			{ name: 'Other', rules: [] }
		];

		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		expect(body.counts).toHaveLength(2);
		expect(body.counts[0]).toEqual({ total: 150, unread: 30 });
	});

	it('returns 401 when not authenticated', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Not authenticated: no refresh token cookie.')
		);

		const event = createMockEvent({ panels: [{ name: 'A', rules: [] }] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toBe('Not authenticated');
		}
	});

	it('returns 401 with session expired for other auth errors', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(new Error('Token refresh failed: invalid_grant'));

		const event = createMockEvent({ panels: [{ name: 'A', rules: [] }] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	it('returns 400 when panels not provided', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');

		const event = createMockEvent({});

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('panels array required');
		}
	});

	it('returns 400 when panels is empty array', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');

		const event = createMockEvent({ panels: [] });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('panels array required');
		}
	});

	it('returns 400 for invalid JSON body', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');

		const event = createMockEvent(); /* No body → JSON parse fails */

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Invalid JSON body');
		}
	});

	it('returns counts array matching panels length', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery)
			.mockReturnValueOnce('from:(@a.com)')
			.mockReturnValueOnce('from:(@b.com)')
			.mockReturnValueOnce('from:(@c.com)')
			.mockReturnValueOnce('-{from:(@a.com)} -{from:(@b.com)} -{from:(@c.com)}');
		vi.mocked(getEstimatedCounts).mockResolvedValue([
			{ total: 100, unread: 10 },
			{ total: 50, unread: 5 },
			{ total: 30, unread: 3 },
			{ total: 200, unread: 80 }
		]);

		const panels = [
			{ name: 'A', rules: [{ field: 'from', pattern: '@a\\.com', action: 'accept' }] },
			{ name: 'B', rules: [{ field: 'from', pattern: '@b\\.com', action: 'accept' }] },
			{ name: 'C', rules: [{ field: 'from', pattern: '@c\\.com', action: 'accept' }] },
			{ name: 'Other', rules: [] }
		];

		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		expect(body.counts).toHaveLength(4);
	});

	it('handles empty catch-all panel (last panel with no rules)', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery)
			.mockReturnValueOnce('from:(@work.com)')
			.mockReturnValueOnce('-{from:(@work.com)}');
		vi.mocked(getEstimatedCounts).mockResolvedValue([
			{ total: 50, unread: 10 },
			{ total: 200, unread: 80 }
		]);

		const panels = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@work\\.com', action: 'accept' }] },
			{ name: 'Other', rules: [] }
		];

		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		expect(body.counts).toHaveLength(2);
		/* panelRulesToGmailQuery should have been called with catchAllNegations. */
		expect(panelRulesToGmailQuery).toHaveBeenCalledTimes(2);
	});

	it('uses empty query for middle panel with no rules', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery)
			.mockReturnValueOnce('from:(@work.com)')
			.mockReturnValueOnce('-{from:(@work.com)}');
		vi.mocked(getEstimatedCounts).mockResolvedValue([
			{ total: 50, unread: 10 },
			{ total: 0, unread: 0 },
			{ total: 200, unread: 80 }
		]);

		const panels = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@work\\.com', action: 'accept' }] },
			{ name: 'Empty Middle', rules: [] } /* middle panel with no rules */,
			{ name: 'Other', rules: [] }
		];

		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		/* The middle panel with no rules gets an empty query → {total:0, unread:0}. */
		expect(body.counts).toHaveLength(3);
		/* getEstimatedCounts should receive ['from:(@work.com)', '', '-{from:(@work.com)}'] */
		const passedQueries = vi.mocked(getEstimatedCounts).mock.calls[0][1];
		expect(passedQueries[1]).toBe('');
	});

	it('returns 500 when Gmail API fails', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery).mockReturnValue('');
		vi.mocked(getEstimatedCounts).mockRejectedValue(
			new Error('Gmail API error (500): Internal Server Error')
		);

		const panels = [{ name: 'All', rules: [] }];
		const event = createMockEvent({ panels });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) expect(err.body.message).toContain('Gmail API error');
		}
	});

	it('returns 401 when Gmail returns auth error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery).mockReturnValue('');
		vi.mocked(getEstimatedCounts).mockRejectedValue(
			new Error('Gmail API error (401): Unauthorized')
		);

		const panels = [{ name: 'All', rules: [] }];
		const event = createMockEvent({ panels });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});
});
