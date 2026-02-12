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
	extractMessageBody
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

	it('prefers text/html over text/plain in multipart/alternative', () => {
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

	it('returns text/html when only HTML is available', () => {
		const payload = {
			mimeType: 'multipart/alternative',
			body: { size: 0 },
			parts: [
				{
					mimeType: 'text/html',
					body: { size: 10, data: Buffer.from('<p>HTML only</p>').toString('base64url') }
				}
			]
		};
		const result = extractMessageBody(payload);
		expect(result.body).toBe('<p>HTML only</p>');
		expect(result.bodyType).toBe('html');
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
});
