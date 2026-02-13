/**
 * @fileoverview Unit tests for the Gmail API client.
 *
 * Tests cover:
 *   - parseBatchResponse: multipart/mixed response parsing
 *   - gmailFetch: authenticated API call wrapper (mocked fetch)
 *   - gmailBatch: batch request construction and chunking
 *   - listThreads: thread listing with pagination
 *   - batchGetThreadMetadata: full metadata pipeline
 *
 * All network calls are mocked with vi.fn() to avoid hitting real APIs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	parseBatchResponse,
	gmailFetch,
	gmailBatch,
	listThreads,
	batchGetThreadMetadata,
	getThreadDetail,
	decodeBase64Url,
	findBodyPart,
	extractMessageBody,
	extractAttachments,
	getAttachment,
	markThreadAsRead,
	batchMarkAsRead,
	batchTrashThreads,
	parseTrashBatchResponse
} from './gmail.js';

// =============================================================================
// parseBatchResponse
// =============================================================================

describe('parseBatchResponse', () => {
	it('parses a single successful part', () => {
		const response = [
			'--batch_boundary',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1","historyId":"100","messages":[{"id":"m1","threadId":"t1","labelIds":["INBOX"],"snippet":"Hello","internalDate":"1704067200000","payload":{"headers":[{"name":"Subject","value":"Test"}]}}]}',
			'--batch_boundary--'
		].join('\r\n');

		const threads = parseBatchResponse(response);
		expect(threads).toHaveLength(1);
		expect(threads[0].id).toBe('t1');
		expect(threads[0].messages[0].snippet).toBe('Hello');
	});

	it('parses multiple successful parts', () => {
		const response = [
			'--batch_boundary',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1","historyId":"100","messages":[]}',
			'--batch_boundary',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t2","historyId":"101","messages":[]}',
			'--batch_boundary--'
		].join('\r\n');

		const threads = parseBatchResponse(response);
		expect(threads).toHaveLength(2);
		expect(threads[0].id).toBe('t1');
		expect(threads[1].id).toBe('t2');
	});

	it('skips parts with non-200 status', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const response = [
			'--batch_boundary',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1","historyId":"100","messages":[]}',
			'--batch_boundary',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 404 Not Found',
			'Content-Type: application/json',
			'',
			'{"error":{"message":"Thread not found"}}',
			'--batch_boundary--'
		].join('\r\n');

		const threads = parseBatchResponse(response);
		expect(threads).toHaveLength(1);
		expect(threads[0].id).toBe('t1');
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('returns empty array for empty response', () => {
		expect(parseBatchResponse('')).toEqual([]);
	});

	it('returns empty array when boundary is missing', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(parseBatchResponse('no boundary here')).toEqual([]);
		errorSpy.mockRestore();
	});

	it('skips parts with malformed JSON', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const response = [
			'--batch_boundary',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{invalid json}',
			'--batch_boundary--'
		].join('\r\n');

		const threads = parseBatchResponse(response);
		expect(threads).toHaveLength(0);
		warnSpy.mockRestore();
	});

	it('handles LF-only line endings (not CRLF)', () => {
		const response = [
			'--batch_boundary',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1","historyId":"100","messages":[]}',
			'--batch_boundary--'
		].join('\n');

		const threads = parseBatchResponse(response);
		expect(threads).toHaveLength(1);
		expect(threads[0].id).toBe('t1');
	});

	it('uses header-supplied boundary when provided', () => {
		const response = [
			'--batch_abc123',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1","historyId":"100","messages":[]}',
			'--batch_abc123--'
		].join('\r\n');

		const threads = parseBatchResponse(response, 'batch_abc123');
		expect(threads).toHaveLength(1);
		expect(threads[0].id).toBe('t1');
	});

	it('parses correctly with header boundary when body has leading whitespace', () => {
		/* Simulates Google returning whitespace before the boundary in the body. */
		const response =
			'\r\n\r\n' +
			[
				'--batch_xyz789',
				'Content-Type: application/http',
				'',
				'HTTP/1.1 200 OK',
				'Content-Type: application/json',
				'',
				'{"id":"t1","historyId":"100","messages":[]}',
				'--batch_xyz789',
				'Content-Type: application/http',
				'',
				'HTTP/1.1 200 OK',
				'Content-Type: application/json',
				'',
				'{"id":"t2","historyId":"101","messages":[]}',
				'--batch_xyz789--'
			].join('\r\n');

		/* Without header boundary, first-line parsing would fail. */
		const threadsWithoutBoundary = parseBatchResponse(response);
		expect(threadsWithoutBoundary).toHaveLength(0);

		/* With header boundary, it should work fine. */
		const threads = parseBatchResponse(response, 'batch_xyz789');
		expect(threads).toHaveLength(2);
		expect(threads[0].id).toBe('t1');
		expect(threads[1].id).toBe('t2');
	});

	it('falls back to first-line parsing when no boundary is provided', () => {
		const response = [
			'--batch_fallback',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1","historyId":"100","messages":[]}',
			'--batch_fallback--'
		].join('\r\n');

		/* No boundary param → uses first-line extraction. */
		const threads = parseBatchResponse(response);
		expect(threads).toHaveLength(1);
		expect(threads[0].id).toBe('t1');
	});

	it('parses parts with HTTP/2 200 status', () => {
		const response = [
			'--batch_boundary',
			'Content-Type: application/http',
			'',
			'HTTP/2 200',
			'Content-Type: application/json',
			'',
			'{"id":"t1","historyId":"100","messages":[{"id":"m1","threadId":"t1","labelIds":["INBOX"],"snippet":"Hello","internalDate":"1704067200000","payload":{"headers":[{"name":"Subject","value":"Test"}]}}]}',
			'--batch_boundary--'
		].join('\r\n');

		const threads = parseBatchResponse(response);
		expect(threads).toHaveLength(1);
		expect(threads[0].id).toBe('t1');
		expect(threads[0].messages[0].snippet).toBe('Hello');
	});

	it('logs first 200 chars when boundary parsing fails without header boundary', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const garbled = 'no boundary here, just random text that is more than enough to debug';
		parseBatchResponse(garbled);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Could not parse batch response boundary'),
			expect.stringContaining('no boundary here')
		);
		errorSpy.mockRestore();
	});

	it('skips HTTP 200 part with no JSON body at all', () => {
		const response = [
			'--batch_boundary',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: text/plain',
			'',
			'no json here',
			'--batch_boundary--'
		].join('\r\n');

		// jsonMatch regex won't match since there's no { ... }, so part is silently skipped
		const threads = parseBatchResponse(response);
		expect(threads).toHaveLength(0);
	});
});

// =============================================================================
// gmailFetch (with mocked global fetch)
// =============================================================================

describe('gmailFetch', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('makes an authenticated GET request to the Gmail API', async () => {
		const mockResponse = { threads: [{ id: 't1', snippet: 'Hello' }] };
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockResponse)
		});

		const result = await gmailFetch('test-token', '/users/me/threads');

		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://gmail.googleapis.com/gmail/v1/users/me/threads',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer test-token'
				})
			})
		);
		expect(result).toEqual(mockResponse);
	});

	it('throws on non-OK response', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 401,
			text: () => Promise.resolve('Unauthorized')
		});

		await expect(gmailFetch('bad-token', '/users/me/threads')).rejects.toThrow(
			'Gmail API error (401)'
		);
	});

	it('throws on network error', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network failure'));

		await expect(gmailFetch('token', '/users/me/threads')).rejects.toThrow('Network failure');
	});

	it('includes additional headers from init', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({})
		});

		await gmailFetch('token', '/test', {
			headers: { 'X-Custom': 'value' }
		});

		expect(globalThis.fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer token',
					'X-Custom': 'value'
				})
			})
		);
	});
});

// =============================================================================
// decodeBase64Url
// =============================================================================

describe('decodeBase64Url', () => {
	it('decodes a simple base64url string', () => {
		/* "Hello, World!" in base64url */
		const encoded = Buffer.from('Hello, World!').toString('base64url');
		expect(decodeBase64Url(encoded)).toBe('Hello, World!');
	});

	it('handles base64url characters (- and _)', () => {
		/* Use a string that produces + and / in standard base64. */
		const original = 'test?with>special+chars/here';
		const encoded = Buffer.from(original).toString('base64url');
		expect(decodeBase64Url(encoded)).toBe(original);
	});

	it('handles empty string', () => {
		expect(decodeBase64Url('')).toBe('');
	});

	it('decodes UTF-8 content (non-ASCII)', () => {
		const original = 'Héllo Wörld 你好';
		const encoded = Buffer.from(original).toString('base64url');
		expect(decodeBase64Url(encoded)).toBe(original);
	});

	it('handles strings without padding', () => {
		/* base64url omits trailing = padding. */
		const original = 'ab';
		const encoded = Buffer.from(original).toString('base64url');
		expect(encoded).not.toContain('=');
		expect(decodeBase64Url(encoded)).toBe(original);
	});
});

// =============================================================================
// findBodyPart
// =============================================================================

describe('findBodyPart', () => {
	it('finds text/plain in a flat part', () => {
		const part = {
			mimeType: 'text/plain',
			body: { size: 5, data: 'SGVsbG8' }
		};
		expect(findBodyPart(part, 'text/plain')).toBe('SGVsbG8');
	});

	it('finds text/html in a flat part', () => {
		const part = {
			mimeType: 'text/html',
			body: { size: 5, data: 'PCFET0NUWVBF' }
		};
		expect(findBodyPart(part, 'text/html')).toBe('PCFET0NUWVBF');
	});

	it('returns undefined for non-matching MIME type', () => {
		const part = {
			mimeType: 'text/plain',
			body: { size: 5, data: 'SGVsbG8' }
		};
		expect(findBodyPart(part, 'text/html')).toBeUndefined();
	});

	it('finds text/plain nested inside multipart/alternative', () => {
		const part = {
			mimeType: 'multipart/alternative',
			body: { size: 0 },
			parts: [
				{ mimeType: 'text/plain', body: { size: 5, data: 'cGxhaW4' } },
				{ mimeType: 'text/html', body: { size: 10, data: 'aHRtbA' } }
			]
		};
		expect(findBodyPart(part, 'text/plain')).toBe('cGxhaW4');
	});

	it('finds text/html nested inside multipart/mixed > multipart/alternative', () => {
		const part = {
			mimeType: 'multipart/mixed',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'multipart/alternative',
					body: { size: 0 },
					parts: [
						{ mimeType: 'text/plain', body: { size: 5, data: 'cGxhaW4' } },
						{ mimeType: 'text/html', body: { size: 10, data: 'aHRtbA' } }
					]
				},
				{
					mimeType: 'application/pdf',
					filename: 'doc.pdf',
					body: { size: 1000, data: 'cGRm' }
				}
			]
		};
		expect(findBodyPart(part, 'text/html')).toBe('aHRtbA');
	});

	it('returns undefined when body data is missing', () => {
		const part = {
			mimeType: 'text/plain',
			body: { size: 0 }
		};
		expect(findBodyPart(part, 'text/plain')).toBeUndefined();
	});

	it('returns undefined for empty parts array', () => {
		const part = {
			mimeType: 'multipart/alternative',
			body: { size: 0 },
			parts: []
		};
		expect(findBodyPart(part, 'text/plain')).toBeUndefined();
	});
});

// =============================================================================
// extractMessageBody
// =============================================================================

describe('extractMessageBody', () => {
	it('extracts text/plain from a simple message', () => {
		const payload = {
			mimeType: 'text/plain',
			body: { size: 13, data: Buffer.from('Hello, World!').toString('base64url') }
		};
		const result = extractMessageBody(payload);
		expect(result.body).toBe('Hello, World!');
		expect(result.bodyType).toBe('text');
	});

	it('extracts and sanitizes text/html from a simple message', () => {
		const html = '<p>Hello <script>alert(1)</script></p>';
		const payload = {
			mimeType: 'text/html',
			body: { size: html.length, data: Buffer.from(html).toString('base64url') }
		};
		const result = extractMessageBody(payload);
		expect(result.body).toBe('<p>Hello </p>');
		expect(result.bodyType).toBe('html');
	});

	it('prefers text/html over text/plain in multipart/alternative (like Gmail)', () => {
		const payload = {
			mimeType: 'multipart/alternative',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'text/plain',
					body: { size: 5, data: Buffer.from('Plain text').toString('base64url') }
				},
				{
					mimeType: 'text/html',
					body: { size: 10, data: Buffer.from('<p>HTML</p>').toString('base64url') }
				}
			]
		};
		const result = extractMessageBody(payload);
		expect(result.body).toBe('<p>HTML</p>');
		expect(result.bodyType).toBe('html');
	});

	it('falls back to text/plain when only plain text is available', () => {
		const payload = {
			mimeType: 'multipart/alternative',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'text/plain',
					body: { size: 10, data: Buffer.from('Only plain').toString('base64url') }
				}
			]
		};
		const result = extractMessageBody(payload);
		expect(result.body).toBe('Only plain');
		expect(result.bodyType).toBe('text');
	});

	it('returns empty body for attachment-only messages', () => {
		const payload = {
			mimeType: 'multipart/mixed',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'application/pdf',
					filename: 'doc.pdf',
					body: { size: 1000 }
				}
			]
		};
		const result = extractMessageBody(payload);
		expect(result.body).toBe('');
		expect(result.bodyType).toBe('text');
	});

	it('handles deeply nested multipart structures', () => {
		const payload = {
			mimeType: 'multipart/mixed',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'multipart/alternative',
					body: { size: 0 },
					parts: [
						{
							mimeType: 'text/plain',
							body: { size: 6, data: Buffer.from('Nested').toString('base64url') }
						}
					]
				}
			]
		};
		const result = extractMessageBody(payload);
		expect(result.body).toBe('Nested');
		expect(result.bodyType).toBe('text');
	});
});

// =============================================================================
// listThreads (with mocked global fetch)
// =============================================================================

describe('listThreads', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns thread IDs and snippets', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					threads: [
						{ id: 't1', snippet: 'Hello', historyId: '100' },
						{ id: 't2', snippet: 'World', historyId: '101' }
					],
					nextPageToken: 'page2'
				})
		});

		const result = await listThreads('test-token');

		expect(result.threads).toHaveLength(2);
		expect(result.threads[0]).toEqual({ id: 't1', snippet: 'Hello' });
		expect(result.threads[1]).toEqual({ id: 't2', snippet: 'World' });
		expect(result.nextPageToken).toBe('page2');
	});

	it('passes pageToken when provided', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token', 'page2');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('pageToken=page2');
	});

	it('does not include pageToken when not provided', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).not.toContain('pageToken');
	});

	it('returns empty array when no threads in response', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({})
		});

		const result = await listThreads('token');
		expect(result.threads).toEqual([]);
		expect(result.nextPageToken).toBeUndefined();
	});

	it('includes maxResults and labelIds=INBOX in query', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token', undefined, 25);

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('maxResults=25');
		expect(calledUrl).toContain('labelIds=INBOX');
	});

	it('uses default maxResults of 50 when not specified', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('maxResults=50');
	});

	it('throws on API error', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 500,
			text: () => Promise.resolve('Internal Server Error')
		});

		await expect(listThreads('token')).rejects.toThrow('Gmail API error (500)');
	});
});

// =============================================================================
// listThreads — Search Query (q parameter)
// =============================================================================

describe('listThreads with search query', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('includes q parameter in URL when provided', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token', undefined, 50, 'from:user@example.com');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('q=from%3Auser%40example.com');
	});

	it('omits q parameter when not provided', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).not.toContain('q=');
	});

	it('omits q parameter when empty string provided', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token', undefined, 50, '');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).not.toContain('q=');
	});

	it('includes both pageToken and q when both provided', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token', 'page2', 50, 'has:attachment');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('pageToken=page2');
		expect(calledUrl).toContain('q=has%3Aattachment');
	});

	it('keeps labelIds=INBOX when q is provided', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token', undefined, 50, 'subject:meeting');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('labelIds=INBOX');
		expect(calledUrl).toContain('q=subject%3Ameeting');
	});

	it('handles q with special characters (quotes, colons, parens)', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ threads: [] })
		});

		await listThreads('token', undefined, 50, 'subject:"team meeting" OR (from:alice)');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		/* The q param should be URL-encoded in the URL. */
		expect(calledUrl).toContain('q=');
		expect(calledUrl).toContain('subject');
	});

	it('returns resultSizeEstimate when present in response', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					threads: [{ id: 't1', snippet: 'Match', historyId: '200' }],
					nextPageToken: 'next',
					resultSizeEstimate: 42
				})
		});

		const result = await listThreads('token', undefined, 50, 'from:test@test.com');

		expect(result.resultSizeEstimate).toBe(42);
		expect(result.nextPageToken).toBe('next');
		expect(result.threads).toHaveLength(1);
	});

	it('returns undefined resultSizeEstimate when not in response', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					threads: [{ id: 't1', snippet: 'Test', historyId: '100' }]
				})
		});

		const result = await listThreads('token');

		expect(result.resultSizeEstimate).toBeUndefined();
	});
});

// =============================================================================
// getEstimatedCounts (with mocked global fetch)
// =============================================================================

describe('getEstimatedCounts', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns {total:0, unread:0} for empty query strings', async () => {
		const { getEstimatedCounts } = await import('./gmail.js');

		const result = await getEstimatedCounts('token', ['']);

		expect(result).toEqual([{ total: 0, unread: 0 }]);
		/* No fetch calls should be made for empty queries. */
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('fetches total and unread estimates for non-empty queries', async () => {
		const { getEstimatedCounts } = await import('./gmail.js');

		(globalThis.fetch as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 150, threads: [] })
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 30, threads: [] })
			});

		const result = await getEstimatedCounts('token', ['from:(@company.com)']);

		expect(result).toHaveLength(1);
		expect(result[0].total).toBe(150);
		expect(result[0].unread).toBe(30);
	});

	it('handles multiple queries in parallel', async () => {
		const { getEstimatedCounts } = await import('./gmail.js');

		/* 4 fetch calls: 2 per query (total + unread) x 2 queries. */
		(globalThis.fetch as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 100 })
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 20 })
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 50 })
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 10 })
			});

		const result = await getEstimatedCounts('token', ['from:a', 'from:b']);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ total: 100, unread: 20 });
		expect(result[1]).toEqual({ total: 50, unread: 10 });
	});

	it('defaults to 0 when resultSizeEstimate is missing', async () => {
		const { getEstimatedCounts } = await import('./gmail.js');

		(globalThis.fetch as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({})
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({})
			});

		const result = await getEstimatedCounts('token', ['from:test']);

		expect(result[0].total).toBe(0);
		expect(result[0].unread).toBe(0);
	});

	it('mixes empty and non-empty queries correctly', async () => {
		const { getEstimatedCounts } = await import('./gmail.js');

		(globalThis.fetch as ReturnType<typeof vi.fn>)
			/* Query 0 ('from:work'): total fetch */
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 200 })
			})
			/* Query 0 ('from:work'): unread fetch */
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 40 })
			})
			/* Query 2 ('from:social'): total fetch */
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 75 })
			})
			/* Query 2 ('from:social'): unread fetch */
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ resultSizeEstimate: 15 })
			});

		const result = await getEstimatedCounts('token', ['from:work', '', 'from:social']);

		/* Index 0: non-empty → fetched with real counts. */
		expect(result[0].total).toBe(200);
		expect(result[0].unread).toBe(40);
		/* Index 1: empty query → skipped, returns {0,0}. */
		expect(result[1]).toEqual({ total: 0, unread: 0 });
		/* Index 2: non-empty → fetched with real counts. */
		expect(result[2].total).toBe(75);
		expect(result[2].unread).toBe(15);
	});
});

// =============================================================================
// gmailBatch (with mocked global fetch)
// =============================================================================

describe('gmailBatch', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns empty array for empty threadIds', async () => {
		const result = await gmailBatch('token', []);
		expect(result).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('sends a batch request and parses the response', async () => {
		const batchResponse = [
			'--batch_response',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1","historyId":"100","messages":[]}',
			'--batch_response--'
		].join('\r\n');

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			headers: new Headers({
				'content-type': 'multipart/mixed; boundary=batch_response'
			}),
			text: () => Promise.resolve(batchResponse)
		});

		const result = await gmailBatch('token', ['t1']);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('t1');
	});

	it('sends Authorization header in batch request', async () => {
		const batchResponse = '--batch\r\n--batch--\r\n';

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			headers: new Headers({ 'content-type': 'multipart/mixed; boundary=batch' }),
			text: () => Promise.resolve(batchResponse)
		});

		await gmailBatch('my-token', ['t1']);

		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://www.googleapis.com/batch/gmail/v1',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer my-token'
				})
			})
		);
	});

	it('throws when batch endpoint returns non-OK', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 403,
			text: () => Promise.resolve('Forbidden')
		});

		await expect(gmailBatch('token', ['t1'])).rejects.toThrow('Gmail batch request failed (403)');
	});

	it('splits requests into chunks of 100', async () => {
		/* Create 150 thread IDs. */
		const threadIds = Array.from({ length: 150 }, (_, i) => `t${i}`);

		const emptyBatchResponse = '--batch\r\n--batch--\r\n';

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			headers: new Headers({ 'content-type': 'multipart/mixed; boundary=batch' }),
			text: () => Promise.resolve(emptyBatchResponse)
		});

		await gmailBatch('token', threadIds);

		/* Should make 2 batch requests (100 + 50). */
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('handles exactly 100 IDs in a single chunk (no unnecessary split)', async () => {
		const threadIds = Array.from({ length: 100 }, (_, i) => `t${i}`);
		const emptyBatchResponse = '--batch\r\n--batch--\r\n';

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			headers: new Headers({ 'content-type': 'multipart/mixed; boundary=batch' }),
			text: () => Promise.resolve(emptyBatchResponse)
		});

		await gmailBatch('token', threadIds);

		// Exactly 100 IDs should be a single batch call, not split
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('handles missing Content-Type boundary in response (undefined responseBoundary)', async () => {
		const batchResponse = [
			'--batch_fallback',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1","historyId":"100","messages":[]}',
			'--batch_fallback--'
		].join('\r\n');

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			headers: new Headers({ 'content-type': 'text/plain' }), // No boundary!
			text: () => Promise.resolve(batchResponse)
		});

		// Should fall back to first-line parsing
		const result = await gmailBatch('token', ['t1']);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('t1');
	});
});

// =============================================================================
// batchGetThreadMetadata (with mocked global fetch)
// =============================================================================

describe('batchGetThreadMetadata', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns empty array for empty threadIds', async () => {
		const result = await batchGetThreadMetadata('token', []);
		expect(result).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('returns parsed thread metadata from batch response', async () => {
		const batchResponse = [
			'--batch_resp',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			JSON.stringify({
				id: 't1',
				historyId: '100',
				messages: [
					{
						id: 'm1',
						threadId: 't1',
						labelIds: ['INBOX', 'UNREAD'],
						snippet: 'Hello from sender',
						internalDate: '1704067200000',
						payload: {
							headers: [
								{ name: 'Subject', value: 'Test Subject' },
								{ name: 'From', value: 'Alice <alice@example.com>' },
								{ name: 'To', value: 'bob@example.com' },
								{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
							]
						}
					}
				]
			}),
			'--batch_resp--'
		].join('\r\n');

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			headers: new Headers({ 'content-type': 'multipart/mixed; boundary=batch_resp' }),
			text: () => Promise.resolve(batchResponse)
		});

		const result = await batchGetThreadMetadata('token', ['t1']);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('t1');
		expect(result[0].subject).toBe('Test Subject');
		expect(result[0].from.name).toBe('Alice');
		expect(result[0].from.email).toBe('alice@example.com');
		expect(result[0].to).toBe('bob@example.com');
		expect(result[0].messageCount).toBe(1);
		expect(result[0].labelIds).toContain('INBOX');
		expect(result[0].labelIds).toContain('UNREAD');
	});

	it('returns metadata for multiple thread IDs', async () => {
		const batchResponse = [
			'--batch_resp',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			JSON.stringify({
				id: 't1',
				historyId: '100',
				messages: [
					{
						id: 'm1',
						threadId: 't1',
						labelIds: ['INBOX'],
						snippet: 'Hello',
						internalDate: '1704067200000',
						payload: {
							headers: [
								{ name: 'Subject', value: 'Subject 1' },
								{ name: 'From', value: 'a@example.com' },
								{ name: 'To', value: 'b@example.com' },
								{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
							]
						}
					}
				]
			}),
			'--batch_resp',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			JSON.stringify({
				id: 't2',
				historyId: '101',
				messages: [
					{
						id: 'm2',
						threadId: 't2',
						labelIds: ['INBOX', 'UNREAD'],
						snippet: 'World',
						internalDate: '1704153600000',
						payload: {
							headers: [
								{ name: 'Subject', value: 'Subject 2' },
								{ name: 'From', value: 'c@example.com' },
								{ name: 'To', value: 'd@example.com' },
								{ name: 'Date', value: 'Tue, 2 Jan 2024 12:00:00 +0000' }
							]
						}
					}
				]
			}),
			'--batch_resp--'
		].join('\r\n');

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			headers: new Headers({ 'content-type': 'multipart/mixed; boundary=batch_resp' }),
			text: () => Promise.resolve(batchResponse)
		});

		const result = await batchGetThreadMetadata('token', ['t1', 't2']);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe('t1');
		expect(result[0].subject).toBe('Subject 1');
		expect(result[1].id).toBe('t2');
		expect(result[1].subject).toBe('Subject 2');
	});
});

// =============================================================================
// getThreadDetail (with mocked global fetch)
// =============================================================================

describe('getThreadDetail', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('fetches thread with format=full and returns parsed detail', async () => {
		const plainBody = Buffer.from('Hello, World!').toString('base64url');
		const mockThread = {
			id: 't1',
			historyId: '100',
			messages: [
				{
					id: 'm1',
					threadId: 't1',
					labelIds: ['INBOX', 'UNREAD'],
					snippet: 'Hello, World!',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Test Thread' },
							{ name: 'From', value: 'Alice <alice@example.com>' },
							{ name: 'To', value: 'bob@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						],
						mimeType: 'text/plain',
						body: { size: 13, data: plainBody }
					}
				}
			]
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');

		expect(result.id).toBe('t1');
		expect(result.subject).toBe('Test Thread');
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].body).toBe('Hello, World!');
		expect(result.messages[0].bodyType).toBe('text');
		expect(result.messages[0].from.name).toBe('Alice');
		expect(result.messages[0].from.email).toBe('alice@example.com');
		expect(result.messages[0].to).toBe('bob@example.com');
		expect(result.messages[0].labelIds).toContain('INBOX');
	});

	it('calls the correct Gmail API endpoint with format=full', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					id: 't1',
					historyId: '100',
					messages: []
				})
		});

		await getThreadDetail('token', 't1');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('/users/me/threads/t1');
		expect(calledUrl).toContain('format=full');
	});

	it('encodes thread ID in the URL', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					id: 'special/id',
					historyId: '100',
					messages: []
				})
		});

		await getThreadDetail('token', 'special/id');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('special%2Fid');
	});

	it('merges label IDs from all messages', async () => {
		const body = Buffer.from('text').toString('base64url');
		const mockThread = {
			id: 't1',
			historyId: '100',
			messages: [
				{
					id: 'm1',
					threadId: 't1',
					labelIds: ['INBOX', 'UNREAD'],
					snippet: 'First',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Subject' },
							{ name: 'From', value: 'a@example.com' },
							{ name: 'To', value: 'b@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						],
						mimeType: 'text/plain',
						body: { size: 4, data: body }
					}
				},
				{
					id: 'm2',
					threadId: 't1',
					labelIds: ['INBOX', 'SENT'],
					snippet: 'Reply',
					internalDate: '1704153600000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Re: Subject' },
							{ name: 'From', value: 'b@example.com' },
							{ name: 'To', value: 'a@example.com' },
							{ name: 'Date', value: 'Tue, 2 Jan 2024 12:00:00 +0000' }
						],
						mimeType: 'text/plain',
						body: { size: 4, data: body }
					}
				}
			]
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');

		/* Should merge labels: INBOX, UNREAD, SENT. */
		expect(result.labelIds).toContain('INBOX');
		expect(result.labelIds).toContain('UNREAD');
		expect(result.labelIds).toContain('SENT');
		expect(result.labelIds).toHaveLength(3);
	});

	it('uses (no subject) when Subject header is missing', async () => {
		const body = Buffer.from('text').toString('base64url');
		const mockThread = {
			id: 't1',
			historyId: '100',
			messages: [
				{
					id: 'm1',
					threadId: 't1',
					labelIds: ['INBOX'],
					snippet: 'text',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'From', value: 'a@example.com' },
							{ name: 'To', value: 'b@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						],
						mimeType: 'text/plain',
						body: { size: 4, data: body }
					}
				}
			]
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');
		expect(result.subject).toBe('(no subject)');
	});

	it('throws on API error', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 404,
			text: () => Promise.resolve('Not Found')
		});

		await expect(getThreadDetail('token', 't1')).rejects.toThrow('Gmail API error (404)');
	});

	it('returns empty messages array when thread has no messages', async () => {
		const mockThread = {
			id: 't1',
			historyId: '100',
			messages: []
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');
		expect(result.messages).toEqual([]);
		expect(result.subject).toBe('(no subject)');
		expect(result.labelIds).toEqual([]);
	});

	it('falls back to text/plain when no HTML is available in multipart', async () => {
		const plainText = 'Plain text only';
		const plainBody = Buffer.from(plainText).toString('base64url');
		const mockThread = {
			id: 't1',
			historyId: '100',
			messages: [
				{
					id: 'm1',
					threadId: 't1',
					labelIds: ['INBOX'],
					snippet: 'Plain text only',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Plain Only' },
							{ name: 'From', value: 'sender@example.com' },
							{ name: 'To', value: 'recipient@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						],
						mimeType: 'multipart/alternative',
						body: { size: 0 },
						parts: [
							{
								mimeType: 'text/plain',
								body: { size: plainText.length, data: plainBody }
							}
						]
					}
				}
			]
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');
		/* No HTML available → falls back to text/plain. */
		expect(result.messages[0].bodyType).toBe('text');
		expect(result.messages[0].body).toBe(plainText);
	});

	it('handles thread with HTML body', async () => {
		const htmlBody = Buffer.from('<p>Hello</p>').toString('base64url');
		const mockThread = {
			id: 't1',
			historyId: '100',
			messages: [
				{
					id: 'm1',
					threadId: 't1',
					labelIds: ['INBOX'],
					snippet: 'Hello',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'HTML Email' },
							{ name: 'From', value: 'a@example.com' },
							{ name: 'To', value: 'b@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						],
						mimeType: 'text/html',
						body: { size: 12, data: htmlBody }
					}
				}
			]
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');
		expect(result.messages[0].bodyType).toBe('html');
		expect(result.messages[0].body).toBe('<p>Hello</p>');
	});

	it('handles thread.messages being undefined (uses ?? [])', async () => {
		const mockThread = {
			id: 't1',
			historyId: '100'
			// messages is undefined
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');
		expect(result.messages).toEqual([]);
		expect(result.subject).toBe('(no subject)');
		expect(result.labelIds).toEqual([]);
	});

	it('handles msg.labelIds being undefined in getThreadDetail', async () => {
		const body = Buffer.from('text').toString('base64url');
		const mockThread = {
			id: 't1',
			historyId: '100',
			messages: [
				{
					id: 'm1',
					threadId: 't1',
					// labelIds is undefined
					snippet: 'Hello',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Test' },
							{ name: 'From', value: 'a@example.com' },
							{ name: 'To', value: 'b@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						],
						mimeType: 'text/plain',
						body: { size: 4, data: body }
					}
				}
			]
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');
		expect(result.messages[0].labelIds).toEqual([]);
		expect(result.labelIds).toEqual([]);
	});

	it('includes attachments in thread detail messages', async () => {
		const plainBody = Buffer.from('Hello').toString('base64url');
		const mockThread = {
			id: 't1',
			historyId: '100',
			messages: [
				{
					id: 'm1',
					threadId: 't1',
					labelIds: ['INBOX'],
					snippet: 'Hello',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'With Attachment' },
							{ name: 'From', value: 'a@example.com' },
							{ name: 'To', value: 'b@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						],
						mimeType: 'multipart/mixed',
						body: { size: 0 },
						parts: [
							{
								mimeType: 'text/plain',
								body: { size: 5, data: plainBody }
							},
							{
								mimeType: 'application/pdf',
								filename: 'report.pdf',
								body: { size: 12345, attachmentId: 'att-1' }
							}
						]
					}
				}
			]
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');
		expect(result.messages[0].attachments).toHaveLength(1);
		expect(result.messages[0].attachments[0]).toEqual({
			filename: 'report.pdf',
			mimeType: 'application/pdf',
			size: 12345,
			attachmentId: 'att-1',
			messageId: 'm1'
		});
	});

	it('returns empty attachments array when message has no attachments', async () => {
		const plainBody = Buffer.from('Hello').toString('base64url');
		const mockThread = {
			id: 't1',
			historyId: '100',
			messages: [
				{
					id: 'm1',
					threadId: 't1',
					labelIds: ['INBOX'],
					snippet: 'Hello',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'No Attachments' },
							{ name: 'From', value: 'a@example.com' },
							{ name: 'To', value: 'b@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						],
						mimeType: 'text/plain',
						body: { size: 5, data: plainBody }
					}
				}
			]
		};

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockThread)
		});

		const result = await getThreadDetail('token', 't1');
		expect(result.messages[0].attachments).toEqual([]);
	});
});

// =============================================================================
// extractAttachments
// =============================================================================

describe('extractAttachments', () => {
	it('finds attachments in a multipart/mixed payload', () => {
		const payload = {
			mimeType: 'multipart/mixed',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'text/plain',
					body: { size: 5, data: 'SGVsbG8' }
				},
				{
					mimeType: 'application/pdf',
					filename: 'doc.pdf',
					body: { size: 5000, attachmentId: 'att-pdf-1' }
				}
			]
		};

		const attachments = extractAttachments(payload, 'msg-1');
		expect(attachments).toHaveLength(1);
		expect(attachments[0]).toEqual({
			filename: 'doc.pdf',
			mimeType: 'application/pdf',
			size: 5000,
			attachmentId: 'att-pdf-1',
			messageId: 'msg-1'
		});
	});

	it('finds multiple attachments', () => {
		const payload = {
			mimeType: 'multipart/mixed',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'text/html',
					body: { size: 10, data: 'aHRtbA' }
				},
				{
					mimeType: 'application/pdf',
					filename: 'report.pdf',
					body: { size: 1000, attachmentId: 'att-1' }
				},
				{
					mimeType: 'image/png',
					filename: 'photo.png',
					body: { size: 2000, attachmentId: 'att-2' }
				}
			]
		};

		const attachments = extractAttachments(payload, 'msg-2');
		expect(attachments).toHaveLength(2);
		expect(attachments[0].filename).toBe('report.pdf');
		expect(attachments[1].filename).toBe('photo.png');
	});

	it('finds attachments in deeply nested MIME structures', () => {
		const payload = {
			mimeType: 'multipart/mixed',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'multipart/alternative',
					body: { size: 0 },
					parts: [
						{ mimeType: 'text/plain', body: { size: 5, data: 'dGV4dA' } },
						{ mimeType: 'text/html', body: { size: 10, data: 'aHRtbA' } }
					]
				},
				{
					mimeType: 'application/zip',
					filename: 'archive.zip',
					body: { size: 50000, attachmentId: 'att-nested' }
				}
			]
		};

		const attachments = extractAttachments(payload, 'msg-3');
		expect(attachments).toHaveLength(1);
		expect(attachments[0].attachmentId).toBe('att-nested');
	});

	it('skips parts with filename but no attachmentId (inline content)', () => {
		const payload = {
			mimeType: 'multipart/mixed',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'image/png',
					filename: 'inline-image.png',
					/* No attachmentId — this is an inline CID-referenced image. */
					body: { size: 100, data: 'aW1hZ2U' }
				}
			]
		};

		const attachments = extractAttachments(payload, 'msg-4');
		expect(attachments).toHaveLength(0);
	});

	it('skips parts with attachmentId but no filename', () => {
		const payload = {
			mimeType: 'multipart/mixed',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'application/octet-stream',
					/* No filename. */
					body: { size: 100, attachmentId: 'att-no-name' }
				}
			]
		};

		const attachments = extractAttachments(payload, 'msg-5');
		expect(attachments).toHaveLength(0);
	});

	it('returns empty array for plain text message (no parts)', () => {
		const payload = {
			mimeType: 'text/plain',
			body: { size: 5, data: 'dGV4dA' }
		};

		const attachments = extractAttachments(payload, 'msg-6');
		expect(attachments).toEqual([]);
	});

	it('handles missing body size gracefully (defaults to 0)', () => {
		const payload = {
			mimeType: 'multipart/mixed',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'application/pdf',
					filename: 'test.pdf',
					body: { attachmentId: 'att-no-size' } as any
				}
			]
		};

		const attachments = extractAttachments(payload, 'msg-7');
		expect(attachments).toHaveLength(1);
		expect(attachments[0].size).toBe(0);
	});
});

// =============================================================================
// getAttachment (with mocked global fetch)
// =============================================================================

describe('getAttachment', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('fetches attachment data from the correct endpoint', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: 'base64urldata', size: 100 })
		});

		const result = await getAttachment('token', 'msg-1', 'att-1');

		expect(result).toBe('base64urldata');
		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('/users/me/messages/msg-1/attachments/att-1');
	});

	it('encodes messageId and attachmentId in the URL', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: 'data', size: 10 })
		});

		await getAttachment('token', 'msg/special', 'att/special');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('msg%2Fspecial');
		expect(calledUrl).toContain('att%2Fspecial');
	});

	it('throws on API error', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 404,
			text: () => Promise.resolve('Not Found')
		});

		await expect(getAttachment('token', 'msg-1', 'att-1')).rejects.toThrow('Gmail API error (404)');
	});
});

// =============================================================================
// markThreadAsRead (with mocked global fetch)
// =============================================================================

describe('markThreadAsRead', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('sends POST to threads/{id}/modify with removeLabelIds UNREAD', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: 't1' })
		});

		await markThreadAsRead('token', 't1');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('/users/me/threads/t1/modify');

		const calledOpts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(calledOpts.method).toBe('POST');

		const body = JSON.parse(calledOpts.body);
		expect(body).toEqual({ removeLabelIds: ['UNREAD'] });
	});

	it('throws on API error', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 400,
			text: () => Promise.resolve('Bad Request')
		});

		await expect(markThreadAsRead('token', 't1')).rejects.toThrow('Gmail API error (400)');
	});

	it('URL-encodes thread IDs with special characters', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: 'special/thread' })
		});

		await markThreadAsRead('token', 'special/thread');

		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledUrl).toContain('special%2Fthread');
	});
});

// =============================================================================
// batchMarkAsRead
// =============================================================================

describe('batchMarkAsRead', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns empty array for empty threadIds', async () => {
		const result = await batchMarkAsRead('token', []);
		expect(result).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('marks multiple threads as read in parallel', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: 'any' })
		});

		const results = await batchMarkAsRead('token', ['t1', 't2', 't3']);

		expect(results).toHaveLength(3);
		expect(results.every((r) => r.success)).toBe(true);
		expect(results[0].threadId).toBe('t1');
		expect(results[1].threadId).toBe('t2');
		expect(results[2].threadId).toBe('t3');
	});

	it('reports individual failures without aborting the batch', async () => {
		/* First call succeeds, second fails, third succeeds. */
		(globalThis.fetch as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
			.mockResolvedValueOnce({
				ok: false,
				status: 404,
				text: () => Promise.resolve('Not Found')
			})
			.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

		const results = await batchMarkAsRead('token', ['t1', 't2', 't3']);

		expect(results[0].success).toBe(true);
		expect(results[1].success).toBe(false);
		expect(results[1].error).toBeDefined();
		expect(results[2].success).toBe(true);
	});

	it('reports all failures when every thread errors', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 500,
			text: () => Promise.resolve('Internal Server Error')
		});

		const results = await batchMarkAsRead('token', ['t1', 't2']);
		expect(results).toHaveLength(2);
		expect(results.every((r) => !r.success)).toBe(true);
		expect(results[0].error).toBeDefined();
		expect(results[1].error).toBeDefined();
	});

	it('marks a single thread as read', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: 't1' })
		});

		const results = await batchMarkAsRead('token', ['t1']);
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({ threadId: 't1', success: true, error: undefined });
	});
});

// =============================================================================
// parseTrashBatchResponse
// =============================================================================

describe('parseTrashBatchResponse', () => {
	it('parses all-success batch response', () => {
		const response = [
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1"}',
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t2"}',
			'--batch_trash--'
		].join('\r\n');

		const results = parseTrashBatchResponse(response, ['t1', 't2'], 'batch_trash');
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({ threadId: 't1', success: true });
		expect(results[1]).toEqual({ threadId: 't2', success: true });
	});

	it('parses mixed success/failure batch response', () => {
		const response = [
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1"}',
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 404 Not Found',
			'Content-Type: application/json',
			'',
			'{"error":{"message":"Thread not found"}}',
			'--batch_trash--'
		].join('\r\n');

		const results = parseTrashBatchResponse(response, ['t1', 't2'], 'batch_trash');
		expect(results[0]).toEqual({ threadId: 't1', success: true });
		expect(results[1].success).toBe(false);
		expect(results[1].error).toContain('Thread not found');
	});

	it('handles missing boundary gracefully (falls back to first line)', () => {
		const response = [
			'--batch_fb',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1"}',
			'--batch_fb--'
		].join('\r\n');

		const results = parseTrashBatchResponse(response, ['t1']);
		expect(results).toHaveLength(1);
		expect(results[0].success).toBe(true);
	});

	it('marks all as failed when boundary cannot be parsed', () => {
		const results = parseTrashBatchResponse('garbled response', ['t1', 't2']);
		expect(results).toHaveLength(2);
		expect(results[0].success).toBe(false);
		expect(results[1].success).toBe(false);
		expect(results[0].error).toContain('Could not parse');
	});

	it('handles missing response parts (marks as failed)', () => {
		/* Only one part but two thread IDs. */
		const response = [
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1"}',
			'--batch_trash--'
		].join('\r\n');

		const results = parseTrashBatchResponse(response, ['t1', 't2'], 'batch_trash');
		expect(results[0].success).toBe(true);
		expect(results[1].success).toBe(false);
		expect(results[1].error).toContain('Missing response part');
	});

	it('handles HTTP/2 200 status', () => {
		const response = [
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/2 200',
			'Content-Type: application/json',
			'',
			'{"id":"t1"}',
			'--batch_trash--'
		].join('\r\n');

		const results = parseTrashBatchResponse(response, ['t1'], 'batch_trash');
		expect(results[0].success).toBe(true);
	});

	it('extracts error message from nested error object', () => {
		const response = [
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 403 Forbidden',
			'Content-Type: application/json',
			'',
			'{"error":{"code":403,"message":"Insufficient permissions"}}',
			'--batch_trash--'
		].join('\r\n');

		const results = parseTrashBatchResponse(response, ['t1'], 'batch_trash');
		expect(results[0].success).toBe(false);
		expect(results[0].error).toBe('Insufficient permissions');
	});

	it('uses default error message when non-200 part has unparseable JSON', () => {
		const response = [
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 500 Internal Server Error',
			'Content-Type: application/json',
			'',
			'{invalid json here}',
			'--batch_trash--'
		].join('\r\n');

		const results = parseTrashBatchResponse(response, ['t1'], 'batch_trash');
		expect(results[0].success).toBe(false);
		expect(results[0].error).toBe('Trash request failed');
	});

	it('handles parsed.error as plain string (not object with message)', () => {
		const response = [
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 403 Forbidden',
			'Content-Type: application/json',
			'',
			'{"error":"Permission denied"}',
			'--batch_trash--'
		].join('\r\n');

		const results = parseTrashBatchResponse(response, ['t1'], 'batch_trash');
		expect(results[0].success).toBe(false);
		expect(results[0].error).toBe('Permission denied');
	});

	it('uses default message when non-200 part has no JSON body', () => {
		const response = [
			'--batch_trash',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 500 Internal Server Error',
			'Content-Type: text/plain',
			'',
			'plain text error',
			'--batch_trash--'
		].join('\r\n');

		const results = parseTrashBatchResponse(response, ['t1'], 'batch_trash');
		expect(results[0].success).toBe(false);
		expect(results[0].error).toBe('Trash request failed');
	});
});

// =============================================================================
// batchTrashThreads (with mocked global fetch)
// =============================================================================

describe('batchTrashThreads', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns empty array for empty threadIds', async () => {
		const result = await batchTrashThreads('token', []);
		expect(result).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('sends batch POST request to the batch endpoint', async () => {
		const batchResponse = [
			'--batch_resp',
			'Content-Type: application/http',
			'',
			'HTTP/1.1 200 OK',
			'Content-Type: application/json',
			'',
			'{"id":"t1"}',
			'--batch_resp--'
		].join('\r\n');

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			headers: new Headers({ 'content-type': 'multipart/mixed; boundary=batch_resp' }),
			text: () => Promise.resolve(batchResponse)
		});

		const results = await batchTrashThreads('token', ['t1']);

		expect(results).toHaveLength(1);
		expect(results[0].success).toBe(true);

		/* Verify the batch endpoint was called with POST requests. */
		const calledOpts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(calledOpts.body).toContain('POST /gmail/v1/users/me/threads/t1/trash');
	});

	it('throws when the batch HTTP request itself fails', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 403,
			text: () => Promise.resolve('Forbidden')
		});

		await expect(batchTrashThreads('token', ['t1'])).rejects.toThrow(
			'Gmail batch trash request failed (403)'
		);
	});

	it('splits requests into chunks of 100 for large sets', async () => {
		const threadIds = Array.from({ length: 150 }, (_, i) => `t${i}`);

		const emptyBatchResponse = ['--batch_resp', '--batch_resp--'].join('\r\n');

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			headers: new Headers({ 'content-type': 'multipart/mixed; boundary=batch_resp' }),
			text: () => Promise.resolve(emptyBatchResponse)
		});

		await batchTrashThreads('token', threadIds);

		// Should make 2 batch calls (100 + 50)
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});
});

// =============================================================================
// Additional Edge Cases: extractAttachments
// =============================================================================

describe('extractAttachments — additional edge cases', () => {
	it('returns empty array when parts is undefined', () => {
		/* A plain text message has no parts array, just a top-level body. */
		const payload = {
			mimeType: 'text/plain',
			body: { data: 'SGVsbG8', size: 5 }
		};
		expect(extractAttachments(payload as any, 'msg-1')).toEqual([]);
	});

	it('skips parts with empty string filename', () => {
		/*
		 * Empty filename is falsy, so the filter should exclude it
		 * just like a missing filename.
		 */
		const payload = {
			mimeType: 'multipart/mixed',
			parts: [
				{
					mimeType: 'application/pdf',
					filename: '',
					body: { attachmentId: 'att-1', size: 100 }
				}
			]
		};
		expect(extractAttachments(payload as any, 'msg-1')).toEqual([]);
	});

	it('defaults body size to 0 when body is missing entirely', () => {
		const payload = {
			mimeType: 'multipart/mixed',
			parts: [
				{
					mimeType: 'application/pdf',
					filename: 'doc.pdf',
					body: { attachmentId: 'att-1' }
					/* no size field */
				}
			]
		};
		const result = extractAttachments(payload as any, 'msg-1');
		expect(result).toHaveLength(1);
		expect(result[0].size).toBe(0);
	});
});

// =============================================================================
// Additional Edge Cases: decodeBase64Url
// =============================================================================

describe('decodeBase64Url — additional edge cases', () => {
	it('handles base64url strings that need 1 byte of padding', () => {
		/* "ab" in base64 = "YWI" (3 chars, needs 1 pad to make multiple of 4). */
		expect(decodeBase64Url('YWI')).toBe('ab');
	});

	it('handles base64url strings that need 2 bytes of padding', () => {
		/* "a" in base64 = "YQ" (2 chars, needs 2 pad). */
		expect(decodeBase64Url('YQ')).toBe('a');
	});
});

// =============================================================================
// getInboxLabelCounts (with mocked global fetch)
// =============================================================================

describe('getInboxLabelCounts', () => {
	beforeEach(() => {
		global.fetch = vi.fn();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('fetches exact INBOX counts via users.labels.get endpoint', async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 'INBOX',
					name: 'INBOX',
					threadsTotal: 1234,
					threadsUnread: 56,
					messagesTotal: 5000,
					messagesUnread: 100
				}),
				{ status: 200 }
			)
		);

		/* Must re-import to use the fresh mock. */
		const { getInboxLabelCounts } = await import('./gmail.js');
		const result = await getInboxLabelCounts('test-token');

		expect(result).toEqual({ total: 1234, unread: 56 });
		expect(global.fetch).toHaveBeenCalledWith(
			expect.stringContaining('/users/me/labels/INBOX'),
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer test-token'
				})
			})
		);
	});

	it('returns zeros when threadsTotal and threadsUnread are missing', async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 'INBOX',
					name: 'INBOX'
					/* threadsTotal and threadsUnread deliberately omitted */
				}),
				{ status: 200 }
			)
		);

		const { getInboxLabelCounts } = await import('./gmail.js');
		const result = await getInboxLabelCounts('test-token');

		expect(result).toEqual({ total: 0, unread: 0 });
	});

	it('returns zeros when threadsTotal and threadsUnread are null', async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 'INBOX',
					name: 'INBOX',
					threadsTotal: null,
					threadsUnread: null,
					messagesTotal: 100,
					messagesUnread: 10
				}),
				{ status: 200 }
			)
		);

		const { getInboxLabelCounts } = await import('./gmail.js');
		const result = await getInboxLabelCounts('test-token');

		expect(result).toEqual({ total: 0, unread: 0 });
	});

	it('throws on Gmail API error (non-200 response)', async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { message: 'Not Found' } }), {
				status: 404,
				statusText: 'Not Found'
			})
		);

		const { getInboxLabelCounts } = await import('./gmail.js');
		await expect(getInboxLabelCounts('test-token')).rejects.toThrow();
	});

	it('handles large inbox counts correctly', async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 'INBOX',
					name: 'INBOX',
					threadsTotal: 42000,
					threadsUnread: 1500,
					messagesTotal: 150000,
					messagesUnread: 5000
				}),
				{ status: 200 }
			)
		);

		const { getInboxLabelCounts } = await import('./gmail.js');
		const result = await getInboxLabelCounts('test-token');

		/* Only returns thread counts, not message counts. */
		expect(result).toEqual({ total: 42000, unread: 1500 });
	});

	it('returns zero unread when all threads are read', async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 'INBOX',
					name: 'INBOX',
					threadsTotal: 100,
					threadsUnread: 0,
					messagesTotal: 200,
					messagesUnread: 0
				}),
				{ status: 200 }
			)
		);

		const { getInboxLabelCounts } = await import('./gmail.js');
		const result = await getInboxLabelCounts('test-token');

		expect(result).toEqual({ total: 100, unread: 0 });
	});

	it('returns zero total for empty inbox', async () => {
		vi.mocked(global.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 'INBOX',
					name: 'INBOX',
					threadsTotal: 0,
					threadsUnread: 0,
					messagesTotal: 0,
					messagesUnread: 0
				}),
				{ status: 200 }
			)
		);

		const { getInboxLabelCounts } = await import('./gmail.js');
		const result = await getInboxLabelCounts('test-token');

		expect(result).toEqual({ total: 0, unread: 0 });
	});
});
