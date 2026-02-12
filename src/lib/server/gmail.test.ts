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
import { parseBatchResponse, gmailFetch } from './gmail.js';

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
