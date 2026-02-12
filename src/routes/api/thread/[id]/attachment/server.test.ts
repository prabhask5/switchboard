/**
 * @fileoverview Integration tests for GET /api/thread/[id]/attachment.
 *
 * Tests cover:
 *   - Successful attachment download with correct headers
 *   - Base64url decoding of attachment data
 *   - Query parameter validation (missing messageId, attachmentId, filename)
 *   - Default mimeType fallback to application/octet-stream
 *   - Filename sanitization (quotes, newlines, null bytes)
 *   - Not authenticated → 401
 *   - Token refresh failure → 401
 *   - Gmail API errors (404, 500, auth)
 *   - Session expired (non-"Not authenticated" getAccessToken errors) → 401
 *   - Non-Error thrown by getAccessToken → 401 "Unknown error"
 *   - Gmail invalid_grant → 401
 *   - Non-Error thrown by getAttachment → 500 "Unknown error"
 *   - Query param validation before auth (early return)
 *   - Content-Length accuracy, empty attachment data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

/* Mock auth and gmail modules before importing the route handler. */
vi.mock('$lib/server/auth.js', () => ({
	getAccessToken: vi.fn()
}));

vi.mock('$lib/server/gmail.js', () => ({
	getAttachment: vi.fn()
}));

import { GET } from './+server.js';
import { getAccessToken } from '$lib/server/auth.js';
import { getAttachment } from '$lib/server/gmail.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal mock SvelteKit RequestEvent for GET /api/thread/[id]/attachment.
 *
 * @param params - URL query parameters to include.
 */
function createMockEvent(params: Record<string, string> = {}) {
	const url = new URL('http://localhost:5173/api/thread/thread123/attachment');
	for (const [key, value] of Object.entries(params)) {
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

/** Standard query params for a valid attachment request. */
const VALID_PARAMS = {
	messageId: 'msg-1',
	attachmentId: 'att-1',
	filename: 'report.pdf',
	mimeType: 'application/pdf'
};

// =============================================================================
// Tests
// =============================================================================

describe('GET /api/thread/[id]/attachment', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── Happy Path ─────────────────────────────────────────────────────

	it('returns binary data with correct headers on success', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		/*
		 * "Hello" in base64url: SGVsbG8 (standard base64: SGVsbG8=)
		 * We simulate Gmail's base64url-encoded attachment data.
		 */
		vi.mocked(getAttachment).mockResolvedValue('SGVsbG8');

		const event = createMockEvent(VALID_PARAMS);
		const response = await GET(event as any);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/pdf');
		expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="report.pdf"');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('Content-Length')).toBeDefined();

		/* Verify the decoded binary matches "Hello". */
		const body = await response.arrayBuffer();
		const text = new TextDecoder().decode(body);
		expect(text).toBe('Hello');
	});

	it('correctly decodes base64url with special characters (- and _)', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		/*
		 * Base64url uses - instead of + and _ instead of /.
		 * The endpoint must convert these before decoding.
		 * "i??>" in standard base64 is "i7+/" → base64url "i7-_"
		 */
		vi.mocked(getAttachment).mockResolvedValue('i7-_');

		const event = createMockEvent(VALID_PARAMS);
		const response = await GET(event as any);

		expect(response.status).toBe(200);
		/* Verify decoding succeeded (no error). */
		const body = await response.arrayBuffer();
		expect(body.byteLength).toBeGreaterThan(0);
	});

	it('defaults mimeType to application/octet-stream when not provided', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(getAttachment).mockResolvedValue('SGVsbG8');

		const { mimeType: _, ...paramsWithoutMime } = VALID_PARAMS;
		const event = createMockEvent(paramsWithoutMime);
		const response = await GET(event as any);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
	});

	it('calls getAttachment with correct messageId and attachmentId', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(getAttachment).mockResolvedValue('SGVsbG8');

		const event = createMockEvent(VALID_PARAMS);
		await GET(event as any);

		expect(getAttachment).toHaveBeenCalledWith('test-token', 'msg-1', 'att-1');
	});

	// ── Filename Sanitization ──────────────────────────────────────────

	it('sanitizes quotes in filename to prevent header injection', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(getAttachment).mockResolvedValue('SGVsbG8');

		const event = createMockEvent({
			...VALID_PARAMS,
			filename: 'file"with"quotes.pdf'
		});
		const response = await GET(event as any);

		const disposition = response.headers.get('Content-Disposition')!;
		/* Quotes replaced with underscores to prevent header injection. */
		expect(disposition).toBe('attachment; filename="file_with_quotes.pdf"');
		expect(disposition).not.toContain('"file"');
	});

	it('sanitizes newlines in filename to prevent header injection', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(getAttachment).mockResolvedValue('SGVsbG8');

		const event = createMockEvent({
			...VALID_PARAMS,
			filename: 'file\r\nwith\nnewlines.pdf'
		});
		const response = await GET(event as any);

		const disposition = response.headers.get('Content-Disposition')!;
		expect(disposition).not.toContain('\r');
		expect(disposition).not.toContain('\n');
	});

	it('sanitizes null bytes in filename', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(getAttachment).mockResolvedValue('SGVsbG8');

		const event = createMockEvent({
			...VALID_PARAMS,
			filename: 'file\0name.pdf'
		});
		const response = await GET(event as any);

		const disposition = response.headers.get('Content-Disposition')!;
		expect(disposition).not.toContain('\0');
		expect(disposition).toBe('attachment; filename="file_name.pdf"');
	});

	// ── Query Parameter Validation ─────────────────────────────────────

	it('returns 400 when messageId is missing', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const { messageId: _, ...params } = VALID_PARAMS;
		const event = createMockEvent(params);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Missing messageId query parameter');
		}
	});

	it('returns 400 when attachmentId is missing', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const { attachmentId: _, ...params } = VALID_PARAMS;
		const event = createMockEvent(params);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400))
				expect(err.body.message).toBe('Missing attachmentId query parameter');
		}
	});

	it('returns 400 when filename is missing', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');

		const { filename: _, ...params } = VALID_PARAMS;
		const event = createMockEvent(params);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
			if (isHttpError(err, 400)) expect(err.body.message).toBe('Missing filename query parameter');
		}
	});

	// ── Authentication ─────────────────────────────────────────────────

	it('returns 401 when not authenticated', async () => {
		vi.mocked(getAccessToken).mockRejectedValue(
			new Error('Not authenticated: no refresh token cookie.')
		);

		const event = createMockEvent(VALID_PARAMS);

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
			new Error('Token refresh failed (400): invalid_grant')
		);

		const event = createMockEvent(VALID_PARAMS);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401)) expect(err.body.message).toContain('Session expired');
		}
	});

	// ── Gmail API Errors ───────────────────────────────────────────────

	it('returns 404 when attachment is not found', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getAttachment).mockRejectedValue(
			new Error('Gmail API error (404): Attachment not found')
		);

		const event = createMockEvent(VALID_PARAMS);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 404)).toBe(true);
			if (isHttpError(err, 404)) expect(err.body.message).toBe('Attachment not found');
		}
	});

	it('returns 401 when Gmail returns auth error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getAttachment).mockRejectedValue(new Error('Gmail API error (401): Unauthorized'));

		const event = createMockEvent(VALID_PARAMS);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401))
				expect(err.body.message).toBe('Session expired. Please sign in again.');
		}
	});

	it('returns 500 when Gmail returns non-auth/non-404 error', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getAttachment).mockRejectedValue(
			new Error('Gmail API error (500): Internal Server Error')
		);

		const event = createMockEvent(VALID_PARAMS);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500))
				expect(err.body.message).toContain('Failed to download attachment');
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

		const event = createMockEvent(VALID_PARAMS);

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
		vi.mocked(getAccessToken).mockRejectedValue('string-error');

		const event = createMockEvent(VALID_PARAMS);

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

	// ── Gmail API: invalid_grant from getAttachment ───────────────────

	it('returns 401 when Gmail error message contains invalid_grant', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getAttachment).mockRejectedValue(new Error('invalid_grant: Token has been revoked'));

		const event = createMockEvent(VALID_PARAMS);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 401)).toBe(true);
			if (isHttpError(err, 401))
				expect(err.body.message).toBe('Session expired. Please sign in again.');
		}
	});

	it('returns 500 with "Unknown error" when Gmail throws a non-Error object', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('token');
		vi.mocked(getAttachment).mockRejectedValue('unexpected-string');

		const event = createMockEvent(VALID_PARAMS);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 500)).toBe(true);
			if (isHttpError(err, 500)) {
				expect(err.body.message).toContain('Failed to download attachment');
				expect(err.body.message).toContain('Unknown error');
			}
		}
	});

	// ── Edge cases: query parameter validation ────────────────────────

	it('validates query params before authenticating (messageId checked first)', async () => {
		/*
		 * The endpoint validates query parameters before calling getAccessToken.
		 * If messageId is missing, it should return 400 without ever touching auth.
		 */
		const { messageId: _, ...params } = VALID_PARAMS;
		const event = createMockEvent(params);

		try {
			await GET(event as any);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect(isHttpError(err, 400)).toBe(true);
		}

		/* getAccessToken should NOT be called when validation fails early. */
		expect(getAccessToken).not.toHaveBeenCalled();
	});

	it('returns correct Content-Length header matching decoded binary size', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		/* "Hello, World!" in base64url (no padding): SGVsbG8sIFdvcmxkIQ */
		vi.mocked(getAttachment).mockResolvedValue('SGVsbG8sIFdvcmxkIQ');

		const event = createMockEvent(VALID_PARAMS);
		const response = await GET(event as any);

		const body = await response.arrayBuffer();
		const contentLength = response.headers.get('Content-Length');
		expect(contentLength).toBe(String(body.byteLength));
	});

	it('handles empty base64url attachment data', async () => {
		vi.mocked(getAccessToken).mockResolvedValue('test-token');
		vi.mocked(getAttachment).mockResolvedValue('');

		const event = createMockEvent(VALID_PARAMS);
		const response = await GET(event as any);

		expect(response.status).toBe(200);
		const body = await response.arrayBuffer();
		expect(body.byteLength).toBe(0);
	});
});
