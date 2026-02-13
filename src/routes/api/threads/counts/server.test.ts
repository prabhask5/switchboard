/**
 * @fileoverview Integration tests for POST /api/threads/counts.
 *
 * Tests cover:
 *   - Authentication errors → 401 (not authenticated, session expired)
 *   - Validation errors → 400 (missing panels, empty array, invalid JSON)
 *   - Gmail API errors → 500 (general) and 401 (auth error from Gmail)
 *   - Exact counts via `getInboxLabelCounts` for no-rules panels without search
 *   - Estimated counts via `getEstimatedCounts` for rules panels
 *   - Search query handling (combination with panel rules, no-rules with search)
 *   - Mixed panel scenarios (rules + no-rules in single request)
 *   - API call minimization (shared counts across no-rules panels)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

/* Mock auth, gmail, and rules modules before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	getAccessToken: vi.fn()
}));

vi.mock('$lib/server/gmail.js', () => ({
	getEstimatedCounts: vi.fn(),
	getInboxLabelCounts: vi.fn()
}));

vi.mock('$lib/rules.js', () => ({
	panelRulesToGmailQuery: vi.fn()
}));

import { POST } from './+server.js';
import { getAccessToken } from '$lib/server/auth.js';
import { getEstimatedCounts, getInboxLabelCounts } from '$lib/server/gmail.js';
import { panelRulesToGmailQuery } from '$lib/rules.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for POST /api/threads/counts.
 *
 * When `body` is provided, `request.json()` resolves with it. When omitted,
 * `request.json()` rejects with a `SyntaxError` to simulate invalid JSON.
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

	// =========================================================================
	// Authentication Tests
	// =========================================================================

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

	// =========================================================================
	// Validation Tests
	// =========================================================================

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

	// =========================================================================
	// Gmail Error Tests
	// =========================================================================

	it('returns 500 when Gmail API fails', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery).mockReturnValue('from:(@work.com)');
		vi.mocked(getEstimatedCounts).mockRejectedValue(
			new Error('Gmail API error (500): Internal Server Error')
		);

		const panels = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@work\\.com', action: 'accept' }] }
		];
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
		vi.mocked(panelRulesToGmailQuery).mockReturnValue('from:(@work.com)');
		vi.mocked(getEstimatedCounts).mockRejectedValue(
			new Error('Gmail API error (401): Unauthorized')
		);

		const panels = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@work\\.com', action: 'accept' }] }
		];
		const event = createMockEvent({ panels });

		try {
			await POST(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	// =========================================================================
	// Exact Counts (No-Rules Panels Without Search)
	// =========================================================================

	it('uses getInboxLabelCounts for no-rules panels without search', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getInboxLabelCounts).mockResolvedValue({ total: 500, unread: 42 });

		const panels = [{ name: 'All Mail', rules: [] }];
		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		/* getInboxLabelCounts should be called exactly once. */
		expect(vi.mocked(getInboxLabelCounts)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(getInboxLabelCounts)).toHaveBeenCalledWith('token');

		/* getEstimatedCounts should NOT be called for no-rules panels without search. */
		expect(vi.mocked(getEstimatedCounts)).not.toHaveBeenCalled();

		/* Response should include exact count with isEstimate: false. */
		expect(body.counts).toHaveLength(1);
		expect(body.counts[0]).toEqual({ total: 500, unread: 42, isEstimate: false });
	});

	it('shares exact count across multiple no-rules panels', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getInboxLabelCounts).mockResolvedValue({ total: 500, unread: 42 });

		const panels = [
			{ name: 'Panel A', rules: [] },
			{ name: 'Panel B', rules: [] },
			{ name: 'Panel C', rules: [] }
		];
		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		/* Only 1 API call regardless of how many no-rules panels. */
		expect(vi.mocked(getInboxLabelCounts)).toHaveBeenCalledTimes(1);

		/* All 3 panels should get the same shared exact count. */
		expect(body.counts).toHaveLength(3);
		for (const count of body.counts) {
			expect(count).toEqual({ total: 500, unread: 42, isEstimate: false });
		}
	});

	it('sets isEstimate: true for rules panels', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery).mockReturnValue('from:(@company.com)');
		vi.mocked(getEstimatedCounts).mockResolvedValue([{ total: 150, unread: 30 }]);

		const panels = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }] }
		];
		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		/* Rules panels always use estimated counts. */
		expect(vi.mocked(getEstimatedCounts)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(getInboxLabelCounts)).not.toHaveBeenCalled();

		expect(body.counts).toHaveLength(1);
		expect(body.counts[0]).toEqual({ total: 150, unread: 30, isEstimate: true });
	});

	// =========================================================================
	// Search Query Tests
	// =========================================================================

	it('combines searchQuery with panel rules query', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery).mockReturnValue('from:(@company.com)');
		vi.mocked(getEstimatedCounts).mockResolvedValue([{ total: 10, unread: 3 }]);

		const panels = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }] }
		];
		const event = createMockEvent({ panels, searchQuery: 'meeting notes' });
		const response = await POST(event as any);
		const body = await response.json();

		/* getEstimatedCounts should receive a combined query: (panelQuery) (searchQuery). */
		expect(vi.mocked(getEstimatedCounts)).toHaveBeenCalledWith('token', [
			'(from:(@company.com)) (meeting notes)'
		]);

		expect(body.counts).toHaveLength(1);
		expect(body.counts[0]).toEqual({ total: 10, unread: 3, isEstimate: true });
	});

	it('uses estimated count for no-rules panel with search', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getEstimatedCounts).mockResolvedValue([{ total: 25, unread: 8 }]);

		const panels = [{ name: 'All Mail', rules: [] }];
		const event = createMockEvent({ panels, searchQuery: 'budget report' });
		const response = await POST(event as any);
		const body = await response.json();

		/* No-rules panel with search → isEstimate: true (not exact). */
		expect(body.counts).toHaveLength(1);
		expect(body.counts[0]).toEqual({ total: 25, unread: 8, isEstimate: true });
	});

	it('uses getEstimatedCounts (not getInboxLabelCounts) when search is active for no-rules panels', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getEstimatedCounts).mockResolvedValue([{ total: 12, unread: 4 }]);

		const panels = [{ name: 'All Mail', rules: [] }];
		const event = createMockEvent({ panels, searchQuery: 'project update' });
		await POST(event as any);

		/* When search is active, getInboxLabelCounts should NOT be called. */
		expect(vi.mocked(getInboxLabelCounts)).not.toHaveBeenCalled();

		/* getEstimatedCounts should be called with the search query. */
		expect(vi.mocked(getEstimatedCounts)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(getEstimatedCounts)).toHaveBeenCalledWith('token', ['project update']);
	});

	// =========================================================================
	// Mixed Panel Tests
	// =========================================================================

	it('handles mix of rules and no-rules panels', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');

		/*
		 * 4 panels: 2 with rules (indices 0, 2), 2 without (indices 1, 3).
		 * No-rules panels → shared exact count via getInboxLabelCounts.
		 * Rules panels → estimated counts via getEstimatedCounts.
		 */
		vi.mocked(panelRulesToGmailQuery)
			.mockReturnValueOnce('from:(@work.com)') /* Panel 0 (rules) */
			.mockReturnValueOnce('from:(@social.com)'); /* Panel 2 (rules) */

		vi.mocked(getInboxLabelCounts).mockResolvedValue({ total: 500, unread: 42 });
		vi.mocked(getEstimatedCounts).mockResolvedValue([
			{ total: 100, unread: 20 } /* Panel 0 estimate */,
			{ total: 50, unread: 5 } /* Panel 2 estimate */
		]);

		const panels = [
			{ name: 'Work', rules: [{ field: 'from', pattern: '@work\\.com', action: 'accept' }] },
			{ name: 'Inbox A', rules: [] },
			{
				name: 'Social',
				rules: [{ field: 'from', pattern: '@social\\.com', action: 'accept' }]
			},
			{ name: 'Inbox B', rules: [] }
		];

		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		expect(body.counts).toHaveLength(4);

		/* Panel 0 (rules) → estimated */
		expect(body.counts[0]).toEqual({ total: 100, unread: 20, isEstimate: true });

		/* Panel 1 (no rules) → exact */
		expect(body.counts[1]).toEqual({ total: 500, unread: 42, isEstimate: false });

		/* Panel 2 (rules) → estimated */
		expect(body.counts[2]).toEqual({ total: 50, unread: 5, isEstimate: true });

		/* Panel 3 (no rules) → exact, same as Panel 1 */
		expect(body.counts[3]).toEqual({ total: 500, unread: 42, isEstimate: false });
	});

	// =========================================================================
	// API Call Minimization Tests
	// =========================================================================

	it('makes only 1 API call for all no-rules panels', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getInboxLabelCounts).mockResolvedValue({ total: 300, unread: 15 });

		const panels = [
			{ name: 'Panel 1', rules: [] },
			{ name: 'Panel 2', rules: [] },
			{ name: 'Panel 3', rules: [] }
		];

		const event = createMockEvent({ panels });
		await POST(event as any);

		/* Regardless of how many no-rules panels, only 1 labels.get call. */
		expect(vi.mocked(getInboxLabelCounts)).toHaveBeenCalledTimes(1);

		/* No threads.list calls needed for no-rules panels without search. */
		expect(vi.mocked(getEstimatedCounts)).not.toHaveBeenCalled();
	});

	it('makes separate API calls per rules panel', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery)
			.mockReturnValueOnce('from:(@a.com)')
			.mockReturnValueOnce('from:(@b.com)')
			.mockReturnValueOnce('from:(@c.com)');
		vi.mocked(getEstimatedCounts).mockResolvedValue([
			{ total: 10, unread: 1 },
			{ total: 20, unread: 2 },
			{ total: 30, unread: 3 }
		]);

		const panels = [
			{ name: 'A', rules: [{ field: 'from', pattern: '@a\\.com', action: 'accept' }] },
			{ name: 'B', rules: [{ field: 'from', pattern: '@b\\.com', action: 'accept' }] },
			{ name: 'C', rules: [{ field: 'from', pattern: '@c\\.com', action: 'accept' }] }
		];

		const event = createMockEvent({ panels });
		await POST(event as any);

		/*
		 * getEstimatedCounts should be called once with all 3 queries.
		 * The endpoint batches all rules queries into a single call.
		 */
		expect(vi.mocked(getEstimatedCounts)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(getEstimatedCounts)).toHaveBeenCalledWith('token', [
			'from:(@a.com)',
			'from:(@b.com)',
			'from:(@c.com)'
		]);

		/* No getInboxLabelCounts call since all panels have rules. */
		expect(vi.mocked(getInboxLabelCounts)).not.toHaveBeenCalled();
	});

	// =========================================================================
	// Additional Coverage Tests
	// =========================================================================

	it('handles mix of rules and no-rules panels correctly', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getInboxLabelCounts).mockResolvedValue({ total: 500, unread: 42 });
		vi.mocked(panelRulesToGmailQuery).mockReturnValue('from:(@work.com)');
		vi.mocked(getEstimatedCounts).mockResolvedValue([{ total: 150, unread: 30 }]);

		const panels = [
			{ name: 'All', rules: [] },
			{ name: 'Work', rules: [{ field: 'from', pattern: '@work\\.com', action: 'accept' }] },
			{ name: 'Other', rules: [] }
		];
		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		/* No-rules panels (indices 0, 2) get exact counts, rules panel (index 1) gets estimate. */
		expect(body.counts).toHaveLength(3);
		expect(body.counts[0]).toEqual({ total: 500, unread: 42, isEstimate: false });
		expect(body.counts[1]).toEqual({ total: 150, unread: 30, isEstimate: true });
		expect(body.counts[2]).toEqual({ total: 500, unread: 42, isEstimate: false });

		/* 1 call for exact counts + 1 call for estimated counts. */
		expect(vi.mocked(getInboxLabelCounts)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(getEstimatedCounts)).toHaveBeenCalledTimes(1);
	});

	it('treats whitespace-only searchQuery as no search', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getInboxLabelCounts).mockResolvedValue({ total: 100, unread: 5 });

		const panels = [{ name: 'All', rules: [] }];
		const event = createMockEvent({ panels, searchQuery: '   ' });
		const response = await POST(event as any);
		const body = await response.json();

		/* Whitespace-only is trimmed to empty → uses exact INBOX count, not estimate. */
		expect(vi.mocked(getInboxLabelCounts)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(getEstimatedCounts)).not.toHaveBeenCalled();
		expect(body.counts[0]).toEqual({ total: 100, unread: 5, isEstimate: false });
	});

	it('uses estimated counts for ALL panels when search is active', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery).mockReturnValue('from:(@work.com)');
		vi.mocked(getEstimatedCounts)
			.mockResolvedValueOnce([{ total: 10, unread: 2 }]) /* no-rules panel search */
			.mockResolvedValueOnce([{ total: 5, unread: 1 }]); /* rules panel search */

		const panels = [
			{ name: 'All', rules: [] },
			{ name: 'Work', rules: [{ field: 'from', pattern: '@work\\.com', action: 'accept' }] }
		];
		const event = createMockEvent({ panels, searchQuery: 'budget report' });
		const response = await POST(event as any);
		const body = await response.json();

		/* Both panels use estimates during search. */
		expect(body.counts[0].isEstimate).toBe(true);
		expect(body.counts[1].isEstimate).toBe(true);
		/* getInboxLabelCounts should NOT be called during search. */
		expect(vi.mocked(getInboxLabelCounts)).not.toHaveBeenCalled();
	});

	it('handles panel with multiple rules correctly', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(panelRulesToGmailQuery).mockReturnValue('{from:(@a.com) from:(@b.com)} -from:(spam)');
		vi.mocked(getEstimatedCounts).mockResolvedValue([{ total: 75, unread: 10 }]);

		const panels = [
			{
				name: 'Mixed',
				rules: [
					{ field: 'from', pattern: '@a\\.com', action: 'accept' },
					{ field: 'from', pattern: '@b\\.com', action: 'accept' },
					{ field: 'from', pattern: 'spam', action: 'reject' }
				]
			}
		];
		const event = createMockEvent({ panels });
		const response = await POST(event as any);
		const body = await response.json();

		expect(body.counts[0]).toEqual({ total: 75, unread: 10, isEstimate: true });
	});

	it('returns 400 when panels is not an array', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		const event = createMockEvent({ panels: 'not-an-array' as any });

		await expect(POST(event as any)).rejects.toMatchObject({
			status: 400
		});
	});
});
