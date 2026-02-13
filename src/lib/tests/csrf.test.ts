/**
 * @fileoverview Unit tests for the client-side CSRF token helper.
 *
 * Tests cover:
 *   - Reading the sb_csrf cookie when present
 *   - Returning null when the cookie is absent
 *   - Handling empty document.cookie
 *   - Cookie position (first, middle, last)
 *   - Not matching partial cookie names
 *   - Handling base64url characters in token values
 *
 * Since this project doesn't have jsdom, we mock the global `document`
 * object directly with a minimal shape that satisfies getCsrfToken().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Test Helpers
// =============================================================================

/** Store the original document (undefined in Node.js). */
const originalDocument = globalThis.document;

/**
 * Sets up a mock document with the given cookie string.
 * getCsrfToken() only reads `document.cookie`, so that's all we need.
 */
function mockDocumentCookie(value: string): void {
	(globalThis as any).document = { cookie: value };
}

beforeEach(() => {
	/* Ensure a clean document mock for each test. */
	(globalThis as any).document = { cookie: '' };
});

afterEach(() => {
	/* Restore original document (or remove it if it didn't exist). */
	if (originalDocument === undefined) {
		delete (globalThis as any).document;
	} else {
		(globalThis as any).document = originalDocument;
	}
});

// =============================================================================
// Tests
// =============================================================================

describe('getCsrfToken', () => {
	it('returns the CSRF token when the cookie exists alone', async () => {
		mockDocumentCookie('sb_csrf=abc123-token_value');

		/* Dynamic import after mocking document so the module sees our mock. */
		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBe('abc123-token_value');
	});

	it('returns null when the cookie is absent', async () => {
		mockDocumentCookie('other_cookie=value; another=xyz');

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBeNull();
	});

	it('returns null when document.cookie is empty', async () => {
		mockDocumentCookie('');

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBeNull();
	});

	it('finds the cookie when it is first in the list', async () => {
		mockDocumentCookie('sb_csrf=first_token; other=value');

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBe('first_token');
	});

	it('finds the cookie when it is last in the list', async () => {
		mockDocumentCookie('other=value; sb_csrf=last_token');

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBe('last_token');
	});

	it('finds the cookie when it is in the middle', async () => {
		mockDocumentCookie('a=1; sb_csrf=middle_token; b=2');

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBe('middle_token');
	});

	it('does not match partial cookie names like xsb_csrf', async () => {
		mockDocumentCookie('xsb_csrf=wrong; notmatched=true');

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBeNull();
	});

	it('does not match sb_csrf_extra as a cookie name', async () => {
		mockDocumentCookie('sb_csrf_extra=wrong');
		/* "sb_csrf_extra=wrong" does NOT start with "sb_csrf=" — the prefix
		   check is "sb_csrf=" (with equals), so "sb_csrf_" won't match. */

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBeNull();
	});

	it('handles base64url characters in token values (-, _, alphanumeric)', async () => {
		const token = 'aBcDeF_123-xYz_456-GhI';
		mockDocumentCookie(`sb_csrf=${token}`);

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBe(token);
	});

	it('handles long base64url token values', async () => {
		/* Real tokens are 32 bytes of randomBytes as base64url (~43 chars). */
		const token = 'dGhpcyBpcyBhIHRlc3QgdG9rZW4gdmFsdWUgZm9yIGNzcmY';
		mockDocumentCookie(`other=1; sb_csrf=${token}; session=abc`);

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBe(token);
	});

	it('returns null for a malformed cookie string without = separator', async () => {
		/*
		 * A malformed cookie entry like "sb_csrf" (no equals sign) should
		 * not be parsed as a valid token — startsWith("sb_csrf=") won't match.
		 */
		mockDocumentCookie('sb_csrf');

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBeNull();
	});

	it('returns null for a whitespace-only cookie value', async () => {
		/*
		 * A whitespace-only CSRF token is never valid. The function trims
		 * the value and returns null if the result is empty.
		 */
		mockDocumentCookie('sb_csrf=   ');

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBeNull();
	});

	it('returns null when cookie value is empty (sb_csrf=)', async () => {
		/*
		 * An empty cookie value is not a valid CSRF token.
		 * The function returns null, same as if the cookie were absent.
		 */
		mockDocumentCookie('sb_csrf=');

		const { getCsrfToken } = await import('../csrf.js');
		expect(getCsrfToken()).toBeNull();
	});
});
